import type { RawData, WebSocket } from 'ws';
import type { ApiModule } from '../api-module.ts';
import { createDeviceAuthGuard } from '../devices/device-auth.ts';
import { debugLog } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { createDeviceUpgradeGuard } from '../platform/http/rate-limit.ts';
import { V2_PATH, parseClientControl, type SessionDto } from './protocol.ts';
import { createSession, envPositiveInt, sendError, sessionUserId } from './session-handlers.ts';
import { closeTurnRoot } from './turn/turn-root.ts';
import { handleBinary, handleControl } from './session.ts';
import { runAnnouncement } from './turn/announce.ts';
import { runTurn } from '../workflows/workflow-voice-turn.ts';
import { diagnoseUpgrade, rejectInvalidControl, socketSummary } from './socket-diagnostics.ts';
import { flushUplink } from './turn/uplink.ts';
import { abortSttStream } from './turn/stream-stt.ts';

const journal = moduleJournal('voice');

export const deviceSocketModule: ApiModule = {
  name: 'device-socket',
  mount(app, deps) {
    // A spoken announcement streams through the turn pipeline's MP3 path.
    deps.deviceSessions.setAnnouncementPlayer((socket, session, announcement) =>
      runAnnouncement(deps.turn, socket, session as SessionDto, announcement));
    const deviceUpgrade = createDeviceUpgradeGuard();
    app.ws(V2_PATH, diagnoseUpgrade, createDeviceAuthGuard(process.env.DEVICE_SHARED_SECRET, deps.getDb), deviceUpgrade.guard, async (request, response) => {
      // This attempt's slot: idempotent, and also freed by the guard when
      // the upgrade's TCP socket closes, whether before, during or after accept.
      const release = deviceUpgrade.releaseFor(request);
      let socket: WebSocket;
      try {
        socket = await response.accept();
      } catch (error) {
        journal('v2.accept_failed', { error_name: error instanceof Error ? error.name : 'Unknown' });
        release();
        return;
      }
      socket.on('close', () => release());
      if (socket.readyState !== socket.OPEN) {
        // Accepted on a connection that is already closing: its close may have
        // fired before the listener above, so free the slot now.
        release();
        return;
      }
      const session = createSession(request.deviceAuth);
      const diagnostic = socketSummary();
      deps.deviceSessions.trackSocket(session);
      socket.on('close', () => deps.deviceSessions.untrackSocket(session));
      journal('v2.connected', { session: session.id, stage: session.stage, peer: request.socket.remoteAddress ?? '' });
      // Peer identity and headers: two devices behind one NAT, or a stale
      // connection lingering after a reboot, are indistinguishable without this.
      debugLog('server.connected', {
        session: session.id,
        peer: request.socket.remoteAddress ?? '',
        peer_port: request.socket.remotePort,
        user_agent: request.headers['user-agent'] ?? '',
        protocol_header: request.headers['sec-websocket-protocol'] ?? '',
        url: request.url ?? '',
      });
      let alive = true;
      let missed = 0;
      socket.on('ping', () => { alive = true; diagnostic.ping(); });
      socket.on('pong', () => { alive = true; diagnostic.pong(); });
      // Every inbound message, audio frames included, runs on one chain in
      // arrival order: hello/list/select await the store, and a frame's validity
      // reads state the chained controls write. Each step's throw is caught so
      // the chain never stalls.
      let controlChain: Promise<void> = Promise.resolve();
      const enqueue = (step: () => void | Promise<void>): void => {
        controlChain = controlChain
          .then(() => step())
          .catch((error: unknown) => {
            journal('v2.control_failed', {
              session: session.id,
              stage: session.stage,
              error: error instanceof Error ? error.name : 'unknown',
            });
          });
      };
      socket.on('message', (raw: RawData, isBinary: boolean) => {
        alive = true;
        if (isBinary) return enqueue(() => handleBinary(deps, socket, session, raw));
        const parsed = parseClientControl(raw);
        if (!parsed.ok) {
          rejectInvalidControl(parsed.code);
          // The raw text of a rejected message, which the journal cannot carry:
          // without it a schema mismatch is only ever "code=BAD_REQUEST".
          debugLog('server.control_rejected', {
            session: session.id,
            stage: session.stage,
            code: parsed.code,
            raw: raw.toString('utf8').slice(0, 2000),
          });
          return sendError(socket, session, parsed.code);
        }
        if (parsed.value.type === 'pong') diagnostic.pong();
        // The turn runs off the control chain; its promise is kept on the
        // session so a `cancel` can abort it and wait for it to unwind.
        enqueue(() => handleControl(deps, socket, session, parsed.value, (turnSession, turnRef) =>
          runTurn(deps.turn, socket, turnSession, turnRef, deps.memoryWorker)));
      });
      const heartbeatMs = envPositiveInt('BOB_WS_HEARTBEAT_MS', 30000);
      const heartbeat = setInterval(() => {
        // While the agent is streaming a reply the device sends nothing and its
        // pong queues behind unread downlink audio, so any liveness check here
        // would falsely terminate a healthy peer. The downlink stall timeout in
        // turn.ts already aborts a stream to a dead device.
        if (session.stage === 'responding') return;
        if (alive) {
          missed = 0;
          alive = false;
          diagnostic.ping();
          socket.ping();
          return;
        }
        missed += 1;
        if (missed >= 2) {
          diagnostic.timeout();
          journal('v2.heartbeat_timeout', { session: session.id, missed });
          socket.terminate();
        }
      }, heartbeatMs);
      socket.on('close', (code: number, reason: Buffer) => {
        diagnostic.close(code);
        flushUplink(session, sessionUserId(session));
        abortSttStream(session);
        // A mid-turn disconnect with no pipeline running would leave the root open; a running pipeline ends it when it settles.
        if (session.turnDone === undefined) closeTurnRoot(session);
        clearInterval(heartbeat);
        journal('v2.closed', {
          session: session.id,
          stage: session.stage,
          code,
          buffered_bytes: socket.bufferedAmount,
          frames_sent: session.downFramesSent ?? 0,
          reason: reason.toString('utf8').slice(0, 64),
        });
      });
      socket.on('close', (code: number, reason: Buffer) =>
        debugLog('server.closed', {
          session: session.id,
          stage: session.stage,
          code,
          // 1006 is an abnormal close: no close frame arrived, so the peer
          // vanished (reboot, Wi-Fi drop, cable) rather than closing cleanly.
          abnormal: code === 1006,
          reason: reason.toString('utf8'),
          buffered_bytes: socket.bufferedAmount,
          frames_sent: session.downFramesSent ?? 0,
        }));
      socket.on('error', (error: Error) => {
        diagnostic.error();
        journal('v2.socket_error', { session: session.id, stage: session.stage, error: error.message.slice(0, 64) });
        debugLog('server.socket_error', {
          session: session.id,
          stage: session.stage,
          error: error.message,
          error_name: error.name,
          stack: error.stack,
        });
      });
    });
  },
};
