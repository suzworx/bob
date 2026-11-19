import { BRAND } from '@/lib/brand';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { FileUIPart } from 'ai';
import { AtSign, AudioLines, Mic, Paperclip, Square } from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatSendButton,
  useChatComposerContext,
  type ChatComposerInputHandle,
} from '@astryxdesign/core/Chat';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Token } from '@astryxdesign/core/Token';
import type { MentionMember } from '@/features/chat/use-mention-picker';
import { useOnline } from '@/lib/use-online';
import type { State as VoiceModeState } from '@/features/voice/mode/conversation-mode';
import type { VoiceError } from '@/features/voice/use-voice';
import {
  ACCEPT_ATTRIBUTE,
  ATTACHMENT_FALLBACK_ERROR,
  ATTACHMENT_TOO_MUCH,
  fileToPart,
  isOverMessageBound,
  validateFiles,
} from './attachments';
import { clearDraft, getDraft, setDraft } from './drafts';
import { platformMentions } from './platform-mentions';
import { useDictation } from './use-dictation';
import {
  buildMentionTrigger,
  mentionName,
  mentionDescription,
  mentionToken,
  normalizeComposerText,
} from './mentions';

// The composer's imperative insert methods mutate the DOM without emitting a
// change, so dispatch an input event to sync its value and clear the placeholder.
function syncComposerValue(): void {
  document.activeElement?.dispatchEvent(new Event('input', { bubbles: true }));
}

// Astryx follows an inserted token with a non-breaking space. When the reader
// types their own space after it, that separator is dropped, so "@riley are
// you free" is sent with one space, not two.
function dropDoubledTokenSpace(value: string): string {
  return value.replace(/ (?=\s)/g, '');
}

// The text between the start of the focused message box and the caret. Astryx's
// handle can insert at the caret but not say what precedes it, so this reads
// the Selection (never moves it) to decide whether a mention needs a space.
function textBeforeCaret(): string {
  const selection = window.getSelection();
  const box = document.activeElement;
  if (!selection || selection.rangeCount === 0 || !box) return '';
  const range = selection.getRangeAt(0).cloneRange();
  if (!box.contains(range.startContainer)) return '';
  range.setStart(box, 0);
  return range.toString();
}

// A drag that carries files. Text dragged inside the message box carries none
// and keeps the browser's own handling.
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

type StagedFile = { id: number; part: FileUIPart };

// The one placeholder every chat uses unless a caller has a reason to differ.
export const COMPOSER_PLACEHOLDER = `Ask ${BRAND.assistantName} anything`;

// The hidden file input takes no space; the Attach button opens it.
const hiddenInput: CSSProperties = { display: 'none' };

// Astryx's own send button stays disabled while the text is empty. An image on
// its own is a complete turn (as in v1), so this one also enables when files
// are staged, and sends them.
// `micFallback` (phone) shows in place of Send while there is nothing to send.
function SendControl({
  hasFiles,
  onSubmit,
  micFallback,
}: {
  hasFiles: boolean;
  onSubmit: (value: string) => void;
  micFallback?: ReactElement | null;
}): ReactElement {
  const composer = useChatComposerContext();
  const value = composer?.value ?? '';
  const textEmpty = normalizeComposerText(value) === '';
  if (micFallback && textEmpty && !hasFiles) return micFallback;
  return (
    <ChatSendButton
      isDisabled={composer?.isStopShown ? false : !composer?.canSend && !hasFiles}
      onSend={() => (textEmpty && hasFiles ? onSubmit('') : composer?.onSubmit(value))}
    />
  );
}

// Voice mode (hands-free), owned by useChatVoice. Without it the composer has
// no Voice mode button; Dictate needs nothing from outside.
export type ComposerVoice = {
  state: VoiceModeState;
  micLive: boolean;
  start: () => void;
  stop: () => void;
  mute: () => void;
  unmute: () => void;
  // Pointer-down silences a spoken reply that is still playing (barge-in).
  onPointerDown: () => void;
  // Names a microphone that cannot be used (denied, missing, unsupported) at the tap.
  onCaptureUnavailable?: (code: VoiceError) => void;
};

// On pointer-down, ask the browser for the microphone once and let go of it
// straight away, so a denied permission, a missing device or an unsupported
// browser is named at the tap rather than failing silently later.
function probeMicrophone(onUnavailable: (code: VoiceError) => void): void {
  if (
    typeof navigator.mediaDevices?.getUserMedia !== 'function' ||
    typeof MediaRecorder === 'undefined'
  ) {
    onUnavailable('unsupported');
    return;
  }
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      for (const track of stream.getTracks()) track.stop();
    })
    .catch((cause: DOMException) => {
      if (cause?.name === 'NotAllowedError') onUnavailable('permission');
      else if (cause?.name === 'NotFoundError') onUnavailable('no_device');
      else onUnavailable('unsupported');
    });
}

// One composer for every chat (the main chat and a space thread alike). The
// toolbar is configuration: `canAttach`, `canMention`, `canDictate` and
// `canVoiceMode` all default to true; Voice mode also needs `voice`. Dictate
// turns speech into text in the box and never sends; Voice mode starts the
// hands-free conversation. Neither is disabled while a reply streams, so the
// reader can always cut in.
//
// `members` comes from the caller, which owns the one members lookup.
// `draftKey` names the chat whose unsent text this composer keeps (drafts.ts),
// so each chat keeps its own; without it the composer keeps none. `fillRef` is
// given a function that puts text in the box (the landing's prompt chips).
// `isDisabled` maps to Astryx's ChatComposer.isDisabled, for a caller with no
// `busy`/stop concept (a thread post) that wants the box inert in flight.
export function Composer({
  busy = false,
  canAttach = true,
  canMention = true,
  canDictate = true,
  canVoiceMode = true,
  canSpeak,
  draftKey,
  fillRef,
  focusRef,
  inputLabel,
  isDisabled,
  members,
  onSend,
  onStop,
  phoneActions,
  placeholder = COMPOSER_PLACEHOLDER,
  status,
  voice,
}: {
  busy?: boolean;
  canAttach?: boolean;
  canMention?: boolean;
  canDictate?: boolean;
  canVoiceMode?: boolean;
  /** @deprecated Use canDictate / canVoiceMode. `false` turns both off. */
  canSpeak?: boolean;
  draftKey?: string;
  fillRef?: RefObject<((text: string) => void) | null>;
  focusRef?: RefObject<(() => void) | null>;
  // Overrides the input's accessible name, kept "Message" for the thread — its
  // callers outside this unit (ThreadPanel, SpacesPage) already query it by
  // that name. Omitted, it keeps Astryx's own default ("Message input").
  inputLabel?: string;
  isDisabled?: boolean;
  members: MentionMember[];
  // A send that can fail (a thread post) returns a rejecting promise; the
  // composer restores the typed text on rejection, as it already does for a
  // busy or oversized refusal.
  onSend: (text: string, files?: FileUIPart[]) => void | Promise<void>;
  onStop?: () => void;
  // Extra icon-only buttons (size="sm") for the phone's top row, after Voice mode,
  // where a surface moves the actions its header drops on a phone.
  phoneActions?: ReactNode;
  placeholder?: string;
  status?: ComponentProps<typeof ChatComposer>['status'];
  voice?: ComposerVoice;
}): ReactElement {
  const handleRef = useRef<ChatComposerInputHandle>(null);
  const inputRootRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isMobile } = useAppShellMobile();
  const dictateOn = canDictate && canSpeak !== false;
  const voiceModeOn = canVoiceMode && canSpeak !== false && voice !== undefined;
  const mentionMembers = useMemo(() => platformMentions(members), [members]);
  const mentionOn = canMention;

  // Dictated words land at the caret, a space after any text before it.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const mutedForDictationRef = useRef(false);
  const dictation = useDictation({
    onText: (text) => {
      const input = handleRef.current;
      if (!input) return;
      input.focus();
      input.insertText(/\S$/.test(textBeforeCaret()) ? ` ${text}` : text);
      syncComposerValue();
    },
    // Hands-free steps aside while a dictation records, so it is not heard twice.
    onRecordingChange: (recording) => {
      const mode = voiceRef.current;
      if (recording && mode?.micLive) {
        mutedForDictationRef.current = true;
        mode.mute();
      } else if (!recording && mutedForDictationRef.current) {
        mutedForDictationRef.current = false;
        mode?.unmute();
      }
    },
  });

  // As Astryx's ai-chat-landing does: focus the box, select what is in it, and
  // replace that with the text, then sync the value.
  useEffect(() => {
    if (!fillRef) return undefined;
    fillRef.current = (text: string): void => {
      const input = handleRef.current;
      if (!input) return;
      input.focus();
      if (document.activeElement) window.getSelection()?.selectAllChildren(document.activeElement);
      input.insertText(text);
      syncComposerValue();
    };
    return () => {
      fillRef.current = null;
    };
  }, [fillRef]);
  useEffect(() => {
    if (!focusRef) return undefined;
    focusRef.current = (): void => { handleRef.current?.focus(); };
    return () => { focusRef.current = null; };
  }, [focusRef]);
  // The key can move under a mounted composer (a new chat adopted as a
  // conversation), so saves read the latest one through a ref.
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  // Put the conversation's unsent text back when the composer mounts. The
  // editor's handle is not ready during the mount itself, so this waits a tick as
  // restoreDraft does; the emptiness check keeps StrictMode's second mount from
  // inserting the text twice.
  useEffect(() => {
    const key = draftKeyRef.current;
    if (key === undefined) return undefined;
    const draft = getDraft(key);
    if (draft === '') return undefined;
    const timer = setTimeout(() => {
      const input = handleRef.current;
      if (!input || input.getValue() !== '') return;
      input.focus();
      input.insertText(draft);
      syncComposerValue();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const rememberDraft = (value: string): void => {
    const key = draftKeyRef.current;
    if (key !== undefined) setDraft(key, normalizeComposerText(value) === '' ? '' : value);
  };
  const nextFileId = useRef(0);
  const triggers = useMemo(() => (canMention ? [buildMentionTrigger(mentionMembers)] : []), [canMention, mentionMembers]);
  // Astryx searches on input, not when its trigger source changes. Refresh an
  // already open search after asynchronous accounts arrive without touching
  // the text, caret or focus. Its public handle has no refresh-search method.
  useEffect(() => {
    const active = document.activeElement;
    if (composingRef.current || active?.getAttribute('aria-expanded') !== 'true' || !inputRootRef.current?.contains(active)) return;
    active.dispatchEvent(new Event('input', { bubbles: true }));
  }, [triggers]);
  const [staged, setStagedState] = useState<StagedFile[]>([]);
  // Files are read asynchronously, so a batch that arrives while another is
  // still loading has to be checked against the tray as it is when it lands,
  // not as the render that started it saw it. The ref is that latest tray;
  // every change goes through setStaged so the ref and the state never differ.
  const stagedRef = useRef<StagedFile[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const setStaged = (update: (prev: StagedFile[]) => StagedFile[]): void => {
    stagedRef.current = update(stagedRef.current);
    setStagedState(stagedRef.current);
  };

  // Picked, pasted or dropped files: check them against v1's bounds, then read
  // the good ones into data URLs. A good batch clears any standing error.
  const stageFiles = (files: File[]): void => {
    const checked = validateFiles(files, stagedRef.current.length);
    if ('error' in checked) {
      setAttachmentError(checked.error);
      return;
    }
    if (checked.accepted.length === 0) return;
    setAttachmentError(null);
    void Promise.all(checked.accepted.map(fileToPart))
      .then((parts) => {
        // Another batch may have landed while these were read: check again.
        const recheck = validateFiles(checked.accepted, stagedRef.current.length);
        if ('error' in recheck) {
          setAttachmentError(recheck.error);
          return;
        }
        setStaged((prev) => [...prev, ...parts.map((part) => ({ id: nextFileId.current++, part }))]);
      })
      .catch(() => setAttachmentError(ATTACHMENT_FALLBACK_ERROR));
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    stageFiles([...(event.target.files ?? [])]);
    // Clear the input so picking the same file again still fires a change.
    event.target.value = '';
  };

  // Astryx has already cleared the editor when it calls back, so a draft that
  // is not sent is put back on the next tick instead of being lost.
  const restoreDraft = (value: string): void => {
    if (normalizeComposerText(value) === '') return;
    setTimeout(() => {
      const input = handleRef.current;
      if (!input) return;
      input.focus();
      input.insertText(value);
      syncComposerValue();
    }, 0);
  };

  // Offline, a send would only fail, so it is held: the text goes back in the
  // box and the staged files and the saved draft stay. The shell's one offline
  // banner says why, so the composer does not say it a second time.
  const online = useOnline();

  const handleSubmit = (value: string): void => {
    const text = normalizeComposerText(dropDoubledTokenSpace(value));
    const files = staged.map((file) => file.part);
    // An image on its own is a complete turn; only neither is refused.
    if (text === '' && files.length === 0) return;
    if (busy || !online) {
      // A turn is in flight, so nothing is sent; the staged files stay.
      restoreDraft(value);
      return;
    }
    if (isOverMessageBound(files)) {
      // Refused, not discarded: the files and the draft both stay.
      setAttachmentError(ATTACHMENT_TOO_MUCH);
      restoreDraft(value);
      return;
    }
    setAttachmentError(null);
    setStaged(() => []);
    // Sent, so no longer a draft. A refused send returned above and keeps it.
    if (draftKeyRef.current !== undefined) clearDraft(draftKeyRef.current);
    const sent = files.length > 0 ? onSend(text, files) : onSend(text);
    if (sent instanceof Promise) sent.catch(() => restoreDraft(value));
  };

  // Astryx does not submit an empty editor on Enter, so with images staged and
  // no text the key sends them here, as the Send button does.
  const sendImagesOnEnter: ComponentProps<typeof ChatComposerInput>['onKeyDown'] = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (staged.length === 0 || normalizeComposerText(handleRef.current?.getValue() ?? '') !== '') return;
    event.preventDefault();
    handleSubmit('');
  };

  // Astryx's DropdownMenu, opened by pointer, moves focus into its list on the
  // next animation frame and never cancels that frame. A pick made before it
  // fired lost the caret to the menu after the token went in, so the next
  // keystrokes landed before the token ("Please summarize@bob") and Bob was
  // never addressed. Frames run in the order they are requested, so inserting
  // in one requested now runs after the menu's, once the close has settled.
  // focus() keeps a caret already in the box, else puts it after the draft;
  // insertToken then leaves it after the token and its separating space.
  const insertMention = (member: MentionMember): void => {
    requestAnimationFrame(() => {
      const input = handleRef.current;
      if (!input) return;
      input.focus();
      if (/\S$/.test(textBeforeCaret())) input.insertText(' ');
      input.insertToken(mentionToken(member));
      syncComposerValue();
    });
  };

  // The people and features a mention can name: the desktop @ menu and the phone top-row @ button list these.
  const mentionItems = mentionMembers.map((member) => (
    <DropdownMenuItem
      key={member.user_id}
      label={mentionName(member)}
      description={mentionDescription(member)}
      onClick={() => insertMention(member)}
    />
  ));

  const toolbar = (
    <>
      {canAttach && (
        <Button
          label="Attach"
          tooltip={isMobile ? undefined : 'Attach files'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={Paperclip} size="sm" />}
          isIconOnly
          onClick={() => fileInputRef.current?.click()}
        />
      )}
      {mentionOn ? (
        <DropdownMenu
          button={{
            label: 'Mention Bob, people or features',
            variant: 'ghost',
            size: 'sm',
            icon: <Icon icon={AtSign} size="sm" />,
            isIconOnly: true,
          }}
          hasChevron={false}
          menuWidth={240}
        >
          {mentionItems}
        </DropdownMenu>
      ) : null}
    </>
  );

  const dictateButton = dictateOn ? (
    <Button
      label={dictation.recording ? 'Stop dictating' : 'Dictate'}
      // On touch the tooltip lingers over the input; the label still names it.
      tooltip={isMobile ? undefined : dictation.recording ? 'Stop and put the words in the box' : 'Speak to type. Nothing is sent'}
      variant={dictation.recording ? 'destructive' : 'ghost'}
      size="sm"
      icon={<Icon icon={dictation.recording ? Square : Mic} size="sm" />}
      isIconOnly
      isLoading={dictation.transcribing}
      onPointerDown={() => voice?.onPointerDown()}
      onClick={dictation.toggle}
    />
  ) : null;
  // Voice mode: the desktop send row and the phone's top row both use this one button.
  const voiceModeButton =
    voiceModeOn && voice ? (
      <Button
        label={voice.state === 'off' ? 'Voice mode' : 'End voice mode'}
        tooltip={isMobile ? undefined : voice.state === 'off' ? `Talk with ${BRAND.assistantName} hands-free` : 'End voice mode'}
        variant={voice.state === 'off' ? 'ghost' : 'secondary'}
        size="sm"
        icon={<Icon icon={voice.state === 'off' ? AudioLines : Square} size="sm" />}
        isIconOnly
        onPointerDown={() => {
          voice.onPointerDown();
          if (voice.state === 'off' && voice.onCaptureUnavailable) probeMicrophone(voice.onCaptureUnavailable);
        }}
        onClick={voice.state === 'off' ? voice.start : voice.stop}
      />
    ) : null;

  return (
    <>
      {canAttach && (
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Upload files"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          style={hiddenInput}
          onChange={onPickFiles}
        />
      )}
      <ChatComposer
        onSubmit={handleSubmit}
        onStop={onStop}
        isStopShown={busy}
        isDisabled={isDisabled}
        density={isMobile ? 'compact' : undefined}
        placeholder={placeholder}
        status={
          attachmentError
            ? { type: 'error', message: attachmentError }
            : dictation.error
              ? { type: 'error', message: dictation.error }
              : status
        }
        onDragOver={
          canAttach
            ? (event) => {
                if (!carriesFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            : undefined
        }
        onDrop={
          canAttach
            ? (event) => {
                if (!carriesFiles(event)) return;
                event.preventDefault();
                stageFiles([...event.dataTransfer.files]);
              }
            : undefined
        }
        drawer={
          canAttach && staged.length > 0 ? (
            <ChatComposerDrawer>
              {staged.map((file) => {
                const label = file.part.filename ?? 'image';
                const remove = (): void =>
                  setStaged((prev) => prev.filter((item) => item.id !== file.id));
                return file.part.mediaType.startsWith('image/') ? (
                  <Thumbnail key={file.id} src={file.part.url} label={label} onRemove={remove} />
                ) : (
                  <Token key={file.id} label={label} onRemove={remove} />
                );
              })}
            </ChatComposerDrawer>
          ) : undefined
        }
        input={
          <ChatComposerInput
            ref={inputRootRef}
            onCompositionStartCapture={() => { composingRef.current = true; }}
            onCompositionEndCapture={() => { composingRef.current = false; }}
            handleRef={handleRef}
            triggers={triggers}
            label={inputLabel}
            onChange={rememberDraft}
            onFiles={canAttach ? stageFiles : undefined}
            onKeyDown={sendImagesOnEnter}
          />
        }
        sendButton={
          <SendControl
            hasFiles={staged.length > 0}
            onSubmit={handleSubmit}
            micFallback={isMobile && !busy ? dictateButton : undefined}
          />
        }
        sendActions={
          isMobile ? undefined : dictateOn || voiceModeOn ? (
            <HStack gap={1}>
              {dictateButton}
              {voiceModeButton}
            </HStack>
          ) : undefined
        }
        // On a phone the top row holds every action as an icon-only button; the
        // desktop row keeps just Attach and @, as before.
        headerActions={
          <HStack gap={1}>
            {toolbar}
            {isMobile && voiceModeButton}
            {isMobile && phoneActions}
          </HStack>
        }
      />
    </>
  );
}
