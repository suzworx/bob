import { describe, expect, it } from 'vitest';
import { collectUiActions, instrumentUiActions } from '../../../scripts/ui-action-instrumentation';

describe('build-time action identities', () => {
  it('treats group refresh notifications as passive without exporting their payloads', () => {
    for (const event of ['bob:group-chat-updated', 'bob:group-chats-changed']) {
      expect(collectUiActions(`window.addEventListener('${event}', refresh)`, 'features/chat/use-group-chat-refresh.ts')).toEqual([]);
    }
  });
  it('instruments distinct controls, menu actions and default links without using runtime values', () => {
    const source = `export function Account() {
      const items = [{ label: 'Sign out', onClick: signOut }];
      return <><Button label="Save" onClick={save} /><Button label="Cancel" clickAction={cancel} />
        <a href={privateUrl}>Private name</a><Profiler onRender={render} /></>;
    }`;
    const actions = collectUiActions(source, 'features/account/account-page.tsx');
    expect(actions.map((action) => action.id)).toEqual([
      'account.account-page.account.menu.sign-out.click',
      'account.account-page.account.button.save.click',
      'account.account-page.account.button.cancel.click-action',
      'account.account-page.account.a.navigate.click',
    ]);
    const transformed = instrumentUiActions(source, 'features/account/account-page.tsx');
    expect(transformed).toContain('onClick={__bobUiAction("account.account-page.account.button.save.click", save)}');
    expect(transformed).toContain('onClick={__bobUiAction("account.account-page.account.a.navigate.click", () => undefined)}');
    expect(transformed).toContain('<Profiler onRender={render} />');
    expect(JSON.stringify(actions)).not.toContain('Private name');
    expect(JSON.stringify(actions)).not.toContain('privateUrl');
  });

  it('keeps identities through whitespace and line changes, and covers nested callbacks and shorthand options', () => {
    const source = `function Editor() { return <Dialog onClose={close}><Button label="Done" onClick={() => done()} /></Dialog>; }`;
    const ids = collectUiActions(source, 'features/productivity/editor.tsx').map(({ id }) => id);
    expect(collectUiActions('\n\n' + source, 'features/productivity/editor.tsx').map(({ id }) => id)).toEqual(ids);
    const transformed = instrumentUiActions(source, 'features/productivity/editor.tsx');
    expect(transformed.match(/__bobUiAction\(/g)).toHaveLength(2);
    const shorthand = collectUiActions('const menu = { onClick };', 'app/menu.ts');
    expect(shorthand).toHaveLength(1);
  });
  it('classifies text edits separately, excludes passive playback ticks and refuses unresolved callback syntax', () => {
    const actions = collectUiActions('<><TextInput onChange={edit} /><Selector onChange={pick} /><input type="file" onChange={upload} /><audio onTimeUpdate={tick} /></>', 'features/forms.tsx');
    expect(actions.map(({ category }) => category)).toEqual(['edit', 'action', 'action']);
    expect(() => collectUiActions('const x = { onClick() {} };', 'app/unknown.ts')).toThrow('Unsupported callback method');
    expect(() => collectUiActions('const x = { ["onClick"]: handler };', 'app/unknown.ts')).toThrow('Unsupported computed callback');
    expect(() => collectUiActions('<Button {...unknownProps()} />', 'app/unknown.tsx')).toThrow('Unresolved JSX callback spread');
    expect(() => collectUiActions('window.addEventListener("keydown", save)', 'app/unknown.tsx')).toThrow('Unclassified native UI listener');
    expect(() => collectUiActions('const handleKeyDown = () => save(); window.addEventListener("keydown", handleKeyDown)', 'features/chat/command-palette.tsx')).toThrow('lost semantic action');
  });
});
