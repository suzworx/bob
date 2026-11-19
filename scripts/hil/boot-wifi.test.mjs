import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineStream, runScenario } from './engine.mjs';
import { waitForBootWifi } from './boot-wifi.mjs';
import { validateScenario } from './schema.mjs';

const event = (ms, name, fields = '') => `${ms} INFO v2.${name} state=WIFI ${fields}`;
const boot = event(900, 'boot', 'fw=0.1.0 build=abc');

describe('boot Wi-Fi recovery policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function run(lines) {
    const device = createLineStream();
    for (const line of lines) device.push(line);
    return waitForBootWifi(device, 0, []);
  }

  it('accepts the ordinary first join without waiting for a backoff', async () => {
    await expect(run([boot, event(2500, 'wifi_connected', 'rssi=-35')])).resolves.toBeUndefined();
  });

  it('accepts the real startup order: wifi_try before boot', async () => {
    await expect(run([event(883, 'wifi_try', 'slot=0 direct=1'),
      event(914, 'boot', 'fw=0.1.0 build=abc'),
      event(3000, 'wifi_connected', 'rssi=-35')])).resolves.toBeUndefined();
  });

  it('bounds missing boot even if startup Wi-Fi events arrive', async () => {
    const pending = run([event(883, 'wifi_try', 'slot=0 direct=1')]);
    const assertion = expect(pending).rejects.toThrow('missing boot evidence');
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });

  it('permits one documented60s failed-round backoff and a successful next scan', async () => {
    await expect(run([boot,
      event(16000, 'wifi_join_failed', 'result=timeout direct=1'),
      event(23000, 'wifi_scan', 'found=1'),
      event(40000, 'wifi_join_failed', 'result=timeout'),
      event(40020, 'wifi_all_failed', 'tried=1 next_retry_ms=60000'),
      event(107500, 'wifi_scan', 'found=1 ms=7000'),
      event(107520, 'wifi_try', 'slot=0'),
      event(112000, 'wifi_connected', 'rssi=-35'),
    ])).resolves.toBeUndefined();
  });

  it('rejects a second failed round instead of waiting through120s backoff', async () => {
    await expect(run([boot,
      event(40000, 'wifi_join_failed'),
      event(40020, 'wifi_all_failed', 'next_retry_ms=60000'),
      event(107500, 'wifi_scan', 'found=1 ms=7000'),
      event(123000, 'wifi_all_failed', 'next_retry_ms=120000'),
    ])).rejects.toThrow('second failed Wi-Fi round');
  });

  it('rejects an unexpected reboot in the wait', async () => {
    await expect(run([boot, boot])).rejects.toThrow('unexpected reboot');
  });

  it('requires failure evidence and the exact first backoff', async () => {
    await expect(run([boot, event(40000, 'wifi_all_failed', 'next_retry_ms=60000')]))
      .rejects.toThrow('missing join failure');
    await expect(run([boot, event(40000, 'wifi_join_failed'), event(40020, 'wifi_all_failed', 'next_retry_ms=120000')]))
      .rejects.toThrow('expected60000ms');
  });

  it('rejects a retry that skips the documented backoff or scan', async () => {
    const prefix = [boot, event(40000, 'wifi_join_failed'), event(40020, 'wifi_all_failed', 'next_retry_ms=60000')];
    await expect(run([...prefix, event(90000, 'wifi_scan', 'found=1 ms=7000')])).rejects.toThrow('before backoff');
    await expect(run([...prefix, event(105000, 'wifi_connected')])).rejects.toThrow('without retry scan');
    await expect(run([...prefix, event(104000, 'wifi_scan', 'found=1 ms=7000')])).rejects.toThrow('started before backoff');
  });

  it('has a finite initial wait when no network events arrive', async () => {
    const pending = run([boot]);
    const assertion = expect(pending).rejects.toThrow('initial Wi-Fi deadline');
    await vi.advanceTimersByTimeAsync(120000);
    await assertion;
  });

  it('rejects buffered events outside the retry-round deadline', async () => {
    await expect(run([boot, event(40000, 'wifi_join_failed'),
      event(40020, 'wifi_all_failed', 'next_retry_ms=60000'),
      event(107500, 'wifi_scan', 'found=1 ms=7000'),
      event(180000, 'wifi_connected'),
    ])).rejects.toThrow('recovery round deadline');
  });

  it('times out a recovery round with no further events', async () => {
    const pending = run([boot, event(40000, 'wifi_join_failed'),
      event(40020, 'wifi_all_failed', 'next_retry_ms=60000')]);
    const assertion = expect(pending).rejects.toThrow('recovery round deadline');
    await vi.advanceTimersByTimeAsync(130800);
    await assertion;
  });

  it('keeps the separate owner-token assertion strict after Wi-Fi recovers', async () => {
    const device = createLineStream();
    const server = createLineStream();
    const result = runScenario({name:'owner',issue:'#611',title:'owner',steps:[
      {send:'T bridge reset',expect:/^ok bridge$/},
      {waitBootWifi:true},
      {waitDevice:/INFO v2\.ws_mode .*auth=2/,timeoutMs:1000},
    ]},{device,server,send(){device.push('T> ok bridge');device.push(boot);device.push(event(3000,'wifi_connected'));device.push(event(3100,'ws_mode','auth=0'));}});
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).status).toBe('fail');
  });

  it('does not allow scenarios to override the policy bounds', () => {
    const scenario = (step) => ({name:'boot',issue:'#611',title:'boot',steps:[step]});
    expect(validateScenario(scenario({waitBootWifi:true}))).toEqual([]);
    expect(validateScenario(scenario({waitBootWifi:true,timeoutMs:600000}))).not.toEqual([]);
    expect(validateScenario(scenario({waitBootWifi:true,since:'run'}))).not.toEqual([]);
  });
});
