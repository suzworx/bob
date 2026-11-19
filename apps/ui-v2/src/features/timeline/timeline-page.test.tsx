import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TimelinePage } from './timeline-page';

const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});

it.each([[true, 'phone'], [false, 'desktop']])('lays out the day controls for %s (%s)', async (isMobile) => {
  shell.isMobile = isMobile;
  render(<TimelinePage />);
  await screen.findByText(entry.title);
  const previous = screen.getByRole('button', { name: 'Previous day' });
  const next = screen.getByRole('button', { name: 'Next day' });
  expect(previous.textContent).toBe(isMobile ? '' : 'Previous day');
  expect(next.textContent).toBe(isMobile ? '' : 'Next day');
  expect(Boolean(screen.queryByRole('button', { name: 'Today' }))).toBe(!isMobile);
  if (!isMobile) expect(screen.queryAllByText('Everything').length).toBeGreaterThan(0);
  if (isMobile) {
    expect(screen.queryByRole('button', { name: /Everything/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Timeline options' }));
    expect(await screen.findByRole('menuitem', { name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Routine runs' })).toBeTruthy();
  }
  shell.isMobile = false;
});
it.each([[true, 'phone'], [false, 'desktop']])('puts the activity explainer above the list only on desktop (%s, %s)', async (isMobile) => {
  shell.isMobile = isMobile;
  render(<TimelinePage />);
  const explainer = /not a complete change log/;
  await screen.findByText(entry.title);
  // The phone keeps it in the options menu (rendered, closed), never as page text above the list.
  const above = screen.queryAllByText(explainer).filter((el) => !el.closest('[role="menuitem"]'));
  expect(above.length > 0).toBe(!isMobile);
  if (isMobile) {
    fireEvent.click(screen.getByRole('button', { name: 'Timeline options' }));
    expect(await screen.findByText(explainer)).toBeTruthy();
  }
  shell.isMobile = false;
});
const state = vi.hoisted(() => ({ fetch:vi.fn<typeof fetch>(), owner:'owner' }));
vi.mock('@/lib/auth/use-session',()=>({fetchWithAuth:state.fetch,useSession:()=>({session:{user:{id:state.owner}}})}));
vi.mock('@/features/routines/routine-conversation',()=>({RoutineConversation:({suggestedPrompt}:{suggestedPrompt:string})=><p>{suggestedPrompt}</p>}));
const entry = {id:'conversation:c1',kind:'conversation',action:'conversation',title:'Planning the week',at:1792790000000,recordId:'conv_12345678',spaceId:null,routineId:null,status:null,count:3};
const json=(body:unknown):Response=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
function response(url:string, entries:unknown[], nextCursor:unknown=null):Response {const params=new URL(url,'http://localhost').searchParams;return json({day:params.get('day'),timeZone:params.get('timeZone'),entries,nextCursor});}
beforeEach(()=>{state.owner='owner';state.fetch.mockReset();state.fetch.mockImplementation(async(url)=>response(String(url),[entry]));});
it('loads the selected local day, navigates days, and prepares a contextual unsent conversation',async()=>{
 render(<TimelinePage/>);await screen.findByText(entry.title);
 const first=new URL(String(state.fetch.mock.calls[0]?.[0]),'http://localhost').searchParams;
 expect(first.get('timeZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
 fireEvent.click(screen.getByRole('button',{name:'Previous day'}));
 await waitFor(()=>expect(state.fetch.mock.calls.length).toBe(2));
 expect(new URL(String(state.fetch.mock.calls[1]?.[0]),'http://localhost').searchParams.get('day')).not.toBe(first.get('day'));
 fireEvent.click(screen.getByRole('button',{name:'Talk about this day'}));
 expect(screen.getByText(/Help me look back on/).textContent).toContain('What happened in my timeline');
 expect(state.fetch.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
});
it('appends cursor pages and preserves earlier visible entries',async()=>{
 state.fetch.mockImplementation(async(url)=>String(url).includes('before=')?response(String(url),[{...entry,id:'conversation:c2',title:'Earlier conversation'}]):response(String(url),[entry],{before:entry.at,beforeId:entry.id}));
 render(<TimelinePage/>);await screen.findByText(entry.title);
 fireEvent.click(screen.getByRole('button',{name:'Show earlier activity'}));
 await screen.findByText('Earlier conversation');expect(screen.getByText(entry.title)).toBeTruthy();
 expect(String(state.fetch.mock.calls[1]?.[0])).toContain('beforeId=conversation%3Ac1');
});
it('ignores a stale day response and clears private activity on owner change',async()=>{
 let resolveOld:(r:Response)=>void=()=>{};
 state.fetch.mockImplementationOnce(async()=>new Promise<Response>(resolve=>{resolveOld=resolve;}));
 const {rerender}=render(<TimelinePage/>);
 fireEvent.click(screen.getByRole('button',{name:'Previous day'}));await screen.findByText(entry.title);
 await act(async()=>resolveOld(response(String(state.fetch.mock.calls[0]?.[0]),[{...entry,title:'Stale response'}])));
 expect(screen.queryByText('Stale response')).toBeNull();
 state.owner='other';state.fetch.mockImplementation(async()=>new Promise<Response>(()=>{}));rerender(<TimelinePage/>);
 expect(screen.queryByText(entry.title)).toBeNull();
});
it('opens a routine recap in place with safe formatted summary content',async()=>{
 state.fetch.mockImplementation(async(url)=>String(url).startsWith('/api/routines/')?json({run:{id:'r1',routineId:'routine-1',routineName:'Morning recap',scheduledAt:1,startedAt:2,completedAt:3,status:'completed',failureCode:null,insightId:'i1',result:{id:'i1',title:'Your recap',summary:'## Highlights\n- Interview tomorrow\n\n**Next step:** reply today.',sources:[],periodStart:1,periodEnd:2,generatedAt:3,partial:false,messageCount:2}}}):response(String(url),[{...entry,id:'routine:r1',kind:'routine',action:'scheduled',recordId:'r1',routineId:'routine-1',title:'Morning recap'}]));
 render(<TimelinePage/>);fireEvent.click(await screen.findByRole('button',{name:/Morning recap/}));
 expect(await screen.findByRole('heading',{name:'Highlights'})).toBeTruthy();
 expect(screen.getByText('Interview tomorrow')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Open routine'}).getAttribute('href')).toBe('/routines#routine-1');
});
