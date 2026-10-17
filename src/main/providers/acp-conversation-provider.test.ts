import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { looksLikePermissionSettingRefusal } from '../../shared/conversation/permissionModes'
import { saveToolResultImagesUnder } from './tool-result-images'
import {
  ACP_PROFILES,
  acpLaunchArgv,
  acpLaunchEnv,
  acpApprovalInput,
  acpMcpServers,
  acpPresetSessionMode,
  acpRawOutputText,
  acpRememberedToolCall,
  acpToolResultImages,
  acpSubagentLaneFields,
  acpTodoTool,
  acpToolKind,
  confinedAcpPath,
  createAcpConversationProvider,
  cursorTransportFailure,
  probeAcpConversationCommands,
} from './acp-conversation-provider'
import type {
  ConversationEvent,
  ConversationImageAttachment,
  ConversationMcpServer,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import { conversationCommandsFor, onConversationCommandsChanged } from '../conversation-commands/registry'
import { projectConversation } from '../../../packages/conversation-timeline/src/conversationProjection'
import { deriveTodoProgress } from '../../../packages/conversation-timeline/src/todoProgress'

// A separate process speaks JSON-RPC over real stdio, including agent-to-client
// permission and file requests. No installed CLI or network is needed in CI.
const agent = `
const { createInterface } = require('node:readline');
let prompt, opened, serial=100, pending=new Map(), model='model-one', mode=null;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const result=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId:'native',update}});
const request=(method,params)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);send({id,method,params})});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(!m.method){pending.get(m.id)?.(m.result||{error:m.error});pending.delete(m.id);return}
 if(m.method==='initialize')return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:!process.env.NO_LOAD,promptCapabilities:{image:!process.env.NO_IMAGES},mcpCapabilities:{http:!!process.env.MCP_HTTP},sessionCapabilities:process.env.FORK?{fork:{}}:{}},authMethods:[],_meta:{availableCommands:[{name:'handshake',description:'Listed before any session'}]}});
 if(m.method==='session/load'&&p.sessionId==='gone')return send({id:m.id,error:{code:-32002,message:'Resource not found'}});
 if(m.method==='session/load'&&require('node:fs').existsSync('busy-session'))return send({id:m.id,error:{code:-32603,message:'Internal error',data:{details:'rate limit reached'}}});
 if((m.method==='session/new'||m.method==='session/load')&&require('node:fs').existsSync('fail-session'))return send({id:m.id,error:{code:-32603,message:'session store unavailable'}});
 if(m.method==='session/new'||m.method==='session/load'){
   opened=m.method;
   if(p.mcpServers?.length)require('node:fs').writeFileSync('mcp-servers.json',JSON.stringify(p.mcpServers));
   if(m.method==='session/load')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY SHOULD BE SUPPRESSED'}});
   // KIMI_MODES: Kimi Code's four session modes, which its presets are told as.
   result(m.id,{...(m.method==='session/new'?{sessionId:'native'}:{}),modes:process.env.KIMI_MODES?{currentModeId:'default',availableModes:['default','plan','auto','yolo'].filter(id=>!process.env.KIMI_MODES.includes('-'+id)).map(id=>({id,name:id}))}:{currentModeId:'agent',availableModes:[{id:'agent',name:'Agent'},{id:'plan',name:'Plan'},{id:'ask',name:'Ask'}]},configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'model-one',options:[{value:'model-one',name:'Model One'},{value:'model-two',name:'Model Two'}]}]});
   // Like Cursor and OpenCode: the command list follows the new session, outside any turn. STRAY
   // text goes first, so a test that has seen the list knows the text was read too.
   if(m.method==='session/new'){if(process.env.STRAY)update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STRAY OUTSIDE A TURN'}});update({sessionUpdate:'available_commands_update',availableCommands:[{name:'review',description:'Review changes',input:{hint:'[commit|branch]'}},{name:'triage',description:'Sort the open issues. (builtin skill)'},{name:'changelog',description:'Draft a changelog entry. (global)'},{name:'always-approve',description:'Toggle approvals',input:{hint:'on|off'}},{name:'exit',description:'Leave'}]})}
   return;
 }
 if(m.method==='session/fork'){require('node:fs').writeFileSync('forked.json',JSON.stringify(p));return result(m.id,{sessionId:'branch-of-'+p.sessionId})}
 if(m.method==='session/set_mode'){mode=p.modeId;return result(m.id,{})}
 if(m.method==='session/set_config_option'){if(p.configId==='model')model=p.value;return result(m.id,{configOptions:[]})}
 if(m.method==='session/cancel'){if(process.env.IGNORE_CANCEL)return;if(prompt)result(prompt,{stopReason:'cancelled'});prompt=null;return}
 if(m.method!=='session/prompt')return result(m.id,{});
 prompt=m.id;const text=p.prompt[0].text;
 if(text.startsWith('/')){if(text==='/refresh')update({sessionUpdate:'available_commands_update',availableCommands:[{name:'fresh',description:'Replaced list'}]});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ran '+text}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 if(text.includes('inspect history')){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});result(m.id,{stopReason:'end_turn'});return}
 if(text==='argv'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({argv:process.argv.slice(2),opened,model,mode,pid:process.pid,permission:process.env.OPENCODE_PERMISSION??null})}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 // A turn that waits on a permission request, and then says which mode the agent is in.
 if(text==='wait then mode'){await request('session/request_permission',{sessionId:'native',toolCall:{toolCallId:'run',kind:'execute',title:'Bash',rawInput:{command:'make'}},options:[{kind:'allow_once',optionId:'allow',name:'Allow'},{kind:'reject_once',optionId:'deny',name:'Deny'}]});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(mode)}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 if(text==='crash')process.exit(2);
 // 'say <words>' answers with the words alone, as Cursor answers a turn its server connection broke.
 if(text.startsWith('say ')){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(4)}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 if(text==='pid'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:String(process.pid)}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 if(text==='flood'){process.stdout.write('x'.repeat(17*1024*1024));return}
 // As OpenCode spawns a subagent: a call named for its task tool, then retitled with what it was sent to do.
 if(text==='task'){update({sessionUpdate:'tool_call',toolCallId:'spawn',kind:'other',title:'task',rawInput:{},status:'pending'});update({sessionUpdate:'tool_call_update',toolCallId:'spawn',kind:'other',title:'Map the tests',rawInput:{description:'Map the tests',prompt:'Find every suite',subagent_type:'explore'},status:'in_progress'});update({sessionUpdate:'tool_call_update',toolCallId:'spawn',status:'completed',content:[{type:'content',content:{type:'text',text:'Three suites.'}}]});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 // As OpenCode 1.18 keeps a checklist: its todowrite tool, ACP kind other, the list only in the
 // call's input, retitled with a count once done, and no plan update. 'todowrite plan' also sends one.
 if(text.startsWith('todowrite')){const todos=[{content:'Read the config',status:'completed',priority:'high'},{content:'Write the test',status:'in_progress',priority:'high'},{content:'Run the suite',status:'pending',priority:'medium'}];update({sessionUpdate:'tool_call',toolCallId:'call_todo',title:'todowrite',kind:'other',status:'pending',locations:[],rawInput:{}});update({sessionUpdate:'tool_call_update',toolCallId:'call_todo',status:'in_progress',kind:'other',title:'todowrite',locations:[],rawInput:{todos}});update({sessionUpdate:'tool_call_update',toolCallId:'call_todo',status:'completed',kind:'other',title:'2 todos',rawInput:{todos},rawOutput:{output:JSON.stringify(todos,null,2),metadata:{todos}},content:[{type:'content',content:{type:'text',text:JSON.stringify(todos,null,2)}}]});if(text==='todowrite plan')update({sessionUpdate:'plan',entries:todos.map(({content,status,priority})=>({content,status:status==='in_progress'?'completed':status,priority}))});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Planned'}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 // As OpenCode returns a screenshot: the picture as an image block beside the text, and again as a
 // data URL among its raw output's attachments. 'screenshot blocks' sends the content alone.
 if(text.startsWith('screenshot')){const data=Buffer.from('not really a png').toString('base64');update({sessionUpdate:'tool_call',toolCallId:'call_shot',kind:'other',title:'screenshot',rawInput:{url:'http://localhost:5173'},status:'pending'});update({sessionUpdate:'tool_call_update',toolCallId:'call_shot',status:'completed',...(text==='screenshot'?{rawOutput:{output:'Captured screenshot',attachments:[{type:'file',mime:'image/png',filename:'screenshot.png',url:'data:image/png;base64,'+data}]}}:{}),content:[{type:'content',content:{type:'text',text:'Captured screenshot'}},{type:'content',content:{type:'image',mimeType:'image/png',data}}]});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Looks right'}});result(m.id,{stopReason:'end_turn'});prompt=null;return}
 // A long tool the agent talks over while it reports progress, then (for 'progress then tool') a new call.
 if(text.startsWith('progress')){const say=t=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:t}});update({sessionUpdate:'tool_call',toolCallId:'long',kind:'execute',title:'Run the suite',rawInput:{},status:'pending'});say('Started the suite. ');update({sessionUpdate:'tool_call_update',toolCallId:'long',status:'in_progress',content:[{type:'content',content:{type:'text',text:'40 of 120'}}]});say('Halfway there. ');update({sessionUpdate:'tool_call_update',toolCallId:'long',status:'completed'});say('All 120 pass.');if(text==='progress then tool'){update({sessionUpdate:'tool_call',toolCallId:'next',kind:'read',title:'Read',rawInput:{},status:'completed'});say('Read it too.')}result(m.id,{stopReason:'end_turn'});prompt=null;return}
 update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}});
 if(text==='hang'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'waiting'}});return}
 update({sessionUpdate:'tool_call',toolCallId:'tool',kind:'edit',title:'Write',rawInput:{path:'result.txt'},status:'pending'});
 const permission=await request('session/request_permission',{sessionId:'native',toolCall:{toolCallId:'tool',kind:'edit',name:'Write'},options:[{kind:text==='broad'?'allow_always':'allow_once',optionId:'allow',name:'Allow'},{kind:'reject_once',optionId:'deny',name:'Deny'}]});
 if(permission.outcome?.outcome==='selected'&&permission.outcome.optionId==='allow'){
  if(text==='write')await request('fs/write_text_file',{sessionId:'native',path:process.cwd()+'/result.txt',content:'approved write'});
  if(text==='create'){const w=await request('fs/write_text_file',{sessionId:'native',path:process.cwd()+'/new.txt',content:'fresh'});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:w.error?'refused: '+w.error.message+' '+JSON.stringify(w.error.data):'created'}})}
  update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',content:[{type:'diff',path:'result.txt',oldText:'',newText:'approved write'}]});
 }
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:permission.outcome?.outcome==='selected'?'Done':'Denied'}});
 result(m.id,{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,totalTokens:12}});prompt=null;
});
`
async function fixture(
  resume = false,
  lostSessionId?: string,
  env: Record<string, string> = {},
  options: Parameters<typeof createAcpConversationProvider>[1] = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'acp-provider-'))
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'test-acp',
    modelId: 'default',
    workspaceRoot: root,
    ...(resume || lostSessionId
      ? {
          resumeSessionId: lostSessionId ?? 'old',
          fallbackHistory: [
            { role: 'user' as const, content: 'persisted question' },
            { role: 'assistant' as const, content: 'persisted answer' },
          ],
        }
      : {}),
  }
  const provider = createAcpConversationProvider(
    {
      id: input.providerId,
      displayName: 'Test agent',
      cli: 'test',
      argv: ['-e', agent],
      authHint: 'Configure test agent.',
      images: true,
      planMode: true,
    },
    {
      detect: async () => process.execPath,
      buildEnv: async () => ({ PATH: process.env.PATH, ...(resume ? { NO_LOAD: '1' } : {}), ...env }),
      startupTimeoutMs: 2000,
      // Short only where the agent ignores the cancel, so a slow machine never
      // ends a process that was about to wind its turn down.
      cancelGraceMs: env.IGNORE_CANCEL ? 300 : 10_000,
      ...options,
    },
  )
  const started = (await provider.startSession(input)) as ConversationEvent[]
  return {
    started,
    root,
    input,
    provider,
    cleanup: async () => {
      provider.disposeAll?.()
      await rm(root, { recursive: true, force: true })
    },
  }
}
// A shipped profile whose CLI is the stand-in agent: the script path leads
// every argv, so the agent receives exactly the flags the profile launches with.
async function presetFixture(
  profileId: string,
  permissionPreset: ConversationPermissionPreset,
  env: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'acp-preset-'))
  const support = await mkdtemp(join(tmpdir(), 'acp-preset-support-'))
  const script = join(support, 'agent.js')
  await writeFile(script, agent)
  const shipped = ACP_PROFILES.find((profile) => profile.id === profileId)!
  const provider = createAcpConversationProvider(
    {
      ...shipped,
      argv: [script, ...shipped.argv],
      presets: Object.fromEntries(
        Object.entries(shipped.presets ?? {}).map(([preset, launch]) => [
          preset,
          { ...launch, ...(launch.argv ? { argv: [script, ...launch.argv] } : {}) },
        ]),
      ),
      authenticate: undefined,
    },
    {
      detect: async () => process.execPath,
      buildEnv: async () => ({ PATH: process.env.PATH, ...env }),
      startupTimeoutMs: 2000,
    },
  )
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: shipped.id,
    modelId: 'default',
    workspaceRoot: root,
    permissionPreset,
  }
  const started = (await provider.startSession(input)) as ConversationEvent[]
  return {
    started,
    root,
    input,
    provider,
    cleanup: async () => {
      provider.disposeAll?.()
      await rm(root, { recursive: true, force: true })
      await rm(support, { recursive: true, force: true })
    },
  }
}
async function launched(f: { provider: ReturnType<typeof createAcpConversationProvider>; input: object }) {
  const text = (await turn(f as Awaited<ReturnType<typeof fixture>>, 'argv'))
    .filter((event) => event.type === 'content_delta')
    .map((event) => event.payload?.text)
    .join('')
  return JSON.parse(text) as {
    argv: string[]
    opened: string
    model: string
    mode: string | null
    pid: number
    permission: string | null
  }
}
async function turn(f: Awaited<ReturnType<typeof fixture>>, message: string) {
  const events: ConversationEvent[] = []
  for await (const event of await f.provider.sendTurn({ ...f.input, turnId: 'turn', requestId: 'request', message })) {
    events.push(event)
    if (event.type === 'approval_requested')
      await f.provider.resolveApproval({
        ...f.input,
        turnId: 'turn',
        requestId: String(event.payload?.requestId),
        approved: true,
      })
  }
  return events
}

test('ACP streams text, reasoning, typed edits, permissions, usage and workspace writes over stdio', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'result.txt'), 'before edit')
    expect(f.provider.listModels()).toEqual(['default', 'model-one', 'model-two'])
    const events = await turn(f, 'write')
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'reasoning_delta',
        'tool_started',
        'tool_output',
        'approval_requested',
        'content_delta',
        'usage_updated',
        'turn_completed',
      ]),
    )
    expect(events.find((event) => event.type === 'tool_started')?.payload).toMatchObject({
      kind: 'file_edit',
      toolUseId: 'tool',
      input: { path: 'result.txt' },
    })
    expect(events.filter((event) => event.type === 'approval_requested')).toHaveLength(2)
    // The write approval shows the change itself, not only where it lands.
    expect(events.filter((event) => event.type === 'approval_requested')[1]?.payload?.input).toMatchObject({
      oldText: 'before edit',
      newText: 'approved write',
    })
    expect(await readFile(join(f.root, 'result.txt'), 'utf8')).toBe('approved write')
    // The turn's end says the agent's last message and what the turn spent.
    const completed = events.find((event) => event.type === 'turn_completed')?.payload
    expect(completed).toMatchObject({
      stopReason: 'end_turn',
      text: 'Done',
      usage: { inputTokens: 10, outputTokens: 2 },
    })
    expect(completed?.usage).not.toHaveProperty('cacheReadTokens')
    expect(f.provider.listLiveSessions?.()[0]).toMatchObject({
      hasChildProcess: true,
      turnActive: false,
      providerSessionId: 'native',
    })
  } finally {
    await f.cleanup()
  }
})
test('ACP keeps the reply whole across progress updates of a tool already running', async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'progress')
    expect(events.at(-1)).toMatchObject({
      type: 'turn_completed',
      payload: { text: 'Started the suite. Halfway there. All 120 pass.' },
    })
  } finally {
    await f.cleanup()
  }
})

test('ACP starts the reply again after a new tool call', async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'progress then tool')
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', payload: { text: 'Read it too.' } })
  } finally {
    await f.cleanup()
  }
})

test('ACP refuses a new-file write before asking for approval it cannot use', async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'create')
    // Only the agent's own tool permission; the callback write is refused unasked.
    expect(events.filter((event) => event.type === 'approval_requested')).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.payload?.text)
        .join(''),
    ).toContain('can edit existing files only')
    await expect(readFile(join(f.root, 'new.txt'), 'utf8')).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
})
test('ACP idle disposal resumes its native session without replaying old text into the turn', async () => {
  const f = await fixture()
  try {
    await turn(f, 'first')
    expect(f.provider.disposeChildProcess?.('session')).toBe(true)
    const events = await turn(f, 'second')
    expect(events.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text)).toEqual([
      'Done',
    ])
  } finally {
    await f.cleanup()
  }
})
test('ACP reports a failed session reload as a failed turn instead of dropping it', async () => {
  const f = await fixture()
  try {
    await turn(f, 'first')
    expect(f.provider.disposeChildProcess?.('session')).toBe(true)
    await writeFile(join(f.root, 'fail-session'), '')
    const events = await turn(f, 'second')
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed' })
    expect(String(events.at(-1)?.payload?.message)).toContain('session store unavailable')
    await rm(join(f.root, 'fail-session'))
    expect((await turn(f, 'third')).at(-1)?.type).toBe('turn_completed')
  } finally {
    await f.cleanup()
  }
})
test('ACP keeps its session when reopening it fails for a reason other than it being gone', async () => {
  const f = await fixture()
  try {
    await turn(f, 'first')
    expect(f.provider.disposeChildProcess?.('session')).toBe(true)
    await writeFile(join(f.root, 'busy-session'), '')
    const events = await turn(f, 'second')
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed' })
    expect(events.some((event) => String(event.payload?.notice ?? '').includes('could not reopen'))).toBe(false)
    await rm(join(f.root, 'busy-session'))
    const reopened = (await turn(f, 'argv')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(JSON.parse(String(reopened)).opened).toBe('session/load')
  } finally {
    await f.cleanup()
  }
})
test('ACP cancellation and child crashes always terminate streaming', async () => {
  const f = await fixture()
  try {
    const events: ConversationEvent[] = []
    for await (const event of await f.provider.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hang',
    })) {
      events.push(event)
      if (event.type === 'content_delta') await f.provider.interrupt(f.input)
    }
    expect(events.some((event) => event.type === 'turn_failed')).toBe(true)
    expect((await turn(f, 'crash')).some((event) => event.type === 'turn_failed')).toBe(true)
  } finally {
    await f.cleanup()
  }
})
// Starts a turn the agent keeps open, and stops it once the agent has spoken.
async function stoppedTurn(f: Awaited<ReturnType<typeof fixture>>, afterStop?: () => void) {
  const events: ConversationEvent[] = []
  for await (const event of await f.provider.sendTurn({
    ...f.input,
    turnId: 'turn',
    requestId: 'request',
    message: 'hang',
  })) {
    events.push(event)
    if (event.type === 'content_delta') {
      await f.provider.interrupt(f.input)
      afterStop?.()
    }
  }
  return events
}
const pidOf = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await turn(f, 'pid')).find((event) => event.type === 'content_delta')?.payload?.text
test('ACP Stop cancels the turn and keeps the process for the next one', async () => {
  const f = await fixture()
  try {
    const before = await pidOf(f)
    const events = await stoppedTurn(f)
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', payload: { reason: 'interrupted' } })
    expect(f.provider.listLiveSessions?.()[0]?.hasChildProcess).toBe(true)
    expect(await pidOf(f)).toBe(before)
    // Not reopened: the session stayed live in the same process.
    expect((await launched(f)).opened).toBe('session/new')
  } finally {
    await f.cleanup()
  }
})
test('ACP Stop while the turn is being set up sends no prompt and keeps the process', async () => {
  const f = await fixture()
  try {
    const before = await pidOf(f)
    // The session reads its hooks off the input it started with.
    Object.assign(f.input, { onBeforeTool: () => f.provider.interrupt(f.input) })
    const events = await turn(f, 'hang')
    Object.assign(f.input, { onBeforeTool: undefined })
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', payload: { reason: 'interrupted' } })
    // The agent never saw the prompt, so it said nothing.
    expect(events.some((event) => event.type === 'reasoning_delta' || event.type === 'content_delta')).toBe(false)
    expect(await pidOf(f)).toBe(before)
  } finally {
    await f.cleanup()
  }
})
test('ACP ends the process of a stopped turn the agent does not wind down', async () => {
  const f = await fixture(false, undefined, { IGNORE_CANCEL: '1' })
  try {
    const before = await pidOf(f)
    const events = await stoppedTurn(f)
    expect(events.at(-1)?.type).toBe('turn_failed')
    expect(f.provider.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
    // The next turn starts a new process and reopens the session.
    expect(await pidOf(f)).not.toBe(before)
  } finally {
    await f.cleanup()
  }
})
test('ACP Settle ends the process of a turn just stopped', async () => {
  const f = await fixture(false, undefined, { IGNORE_CANCEL: '1' })
  try {
    let disposed: boolean | undefined
    const events = await stoppedTurn(f, () => {
      disposed = f.provider.disposeChildProcess?.('session')
    })
    expect(disposed).toBe(true)
    expect(events.at(-1)?.type).toBe('turn_failed')
    expect(f.provider.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('ACP forced disposal ends a turn still running', async () => {
  const f = await fixture()
  try {
    const events: ConversationEvent[] = []
    for await (const event of await f.provider.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hang',
    })) {
      events.push(event)
      if (event.type === 'content_delta') {
        expect(f.provider.disposeChildProcess?.('session')).toBe(false)
        expect(f.provider.disposeChildProcess?.('session', { force: true })).toBe(true)
      }
    }
    expect(events.at(-1)?.type).toBe('turn_failed')
    expect(f.provider.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('ACP ends an agent whose protocol line exceeds the size limit', async () => {
  const f = await fixture()
  try {
    expect((await turn(f, 'flood')).at(-1)?.type).toBe('turn_failed')
    expect(f.provider.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('ACP without native loading restores persisted history after application restart', async () => {
  const f = await fixture(true)
  try {
    const content = (await turn(f, 'inspect history')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(content).toContain('persisted question')
    expect(content).toContain('persisted answer')
    expect(content).toContain('inspect history')
  } finally {
    await f.cleanup()
  }
})
test('ACP continues in a new session with replayed history when its stored session is gone', async () => {
  const f = await fixture(false, 'gone')
  try {
    const notice = f.started.find((event) => event.type === 'session_updated')
    expect(notice?.payload).toMatchObject({ providerSessionId: 'native' })
    expect(String(notice?.payload?.notice)).toContain('could not reopen its previous session')
    const content = (await turn(f, 'inspect history')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(content).toContain('persisted question')
    expect(content).toContain('inspect history')
  } finally {
    await f.cleanup()
  }
})
test('ACP shutdown during executable discovery never spawns a late child', async () => {
  let finish!: (path: string) => void
  const detection = new Promise<string>((resolve) => {
    finish = resolve
  })
  const provider = createAcpConversationProvider(
    {
      id: 'late',
      displayName: 'Late',
      cli: 'test',
      argv: ['-e', agent],
      authHint: 'Configure agent.',
      images: false,
      planMode: false,
    },
    { detect: () => detection, buildEnv: async () => ({}) },
  )
  const pending = provider.startSession({
    sessionId: 'late',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'late',
    modelId: 'default',
    workspaceRoot: tmpdir(),
  })
  provider.disposeAll?.()
  finish(process.execPath)
  await expect(pending).rejects.toThrow('stopped during startup')
  expect(provider.listLiveSessions?.()).toEqual([])
})
test('ACP reports a CLI that cannot be started without a misleading sign-in hint', async () => {
  const provider = createAcpConversationProvider(
    {
      id: 'missing',
      displayName: 'Missing',
      cli: 'test',
      argv: ['acp'],
      authHint: 'Run missing login in a terminal.',
      images: false,
      planMode: false,
    },
    { detect: async () => join(tmpdir(), 'no-such-acp-agent'), buildEnv: async () => ({}) },
  )
  const pending = provider.startSession({
    sessionId: 'missing',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'missing',
    modelId: 'default',
    workspaceRoot: tmpdir(),
  })
  await expect(pending).rejects.toThrow(/Missing could not be started from .*no-such-acp-agent: .*ENOENT/)
  await expect(pending).rejects.not.toThrow('login')
  expect(provider.listLiveSessions?.()).toEqual([])
})
test('ACP handshake timeout disposes the child and cannot publish a late connection', async () => {
  const slow = `setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:0,result:{protocolVersion:1}})+'\\n')},2000);process.stdin.resume()`
  const provider = createAcpConversationProvider(
    {
      id: 'slow',
      displayName: 'Slow',
      cli: 'test',
      argv: ['-e', slow],
      authHint: 'Configure agent.',
      images: false,
      planMode: false,
    },
    { detect: async () => process.execPath, buildEnv: async () => ({}), startupTimeoutMs: 20 },
  )
  await expect(
    provider.startSession({
      sessionId: 'slow',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'slow',
      modelId: 'default',
      workspaceRoot: tmpdir(),
    }),
  ).rejects.toThrow('timed out')
  expect(provider.listLiveSessions?.()).toEqual([])
  provider.disposeAll?.()
})
test('ACP finds the refused flag above the usage text a CLI prints after it', async () => {
  const usage = Array.from({ length: 30 }, (_, index) => `  --option-${index}   what option ${index} does`).join('\\n')
  const refuses = `process.stderr.write("error: unknown option '--permission-mode'\\n\\nUsage: agent [options]\\n\\nOptions:\\n${usage}\\n");process.exit(1)`
  const provider = createAcpConversationProvider(
    {
      id: 'old-build',
      displayName: 'Old build',
      cli: 'test',
      argv: ['-e', refuses],
      authHint: 'Run agent login in a terminal.',
      images: false,
      planMode: false,
    },
    { detect: async () => process.execPath, buildEnv: async () => ({}) },
  )
  const pending = provider.startSession({
    sessionId: 'old-build',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'old-build',
    modelId: 'default',
    workspaceRoot: tmpdir(),
  })
  const message = await Promise.resolve(pending).then(
    () => '',
    (error: Error) => error.message,
  )
  expect(message).toContain("unknown option '--permission-mode'")
  expect(looksLikePermissionSettingRefusal(message)).toBe(true)
})
test('ACP says what a CLI that exits at start printed, so a refused flag reads as that', async () => {
  const refuses = `process.stderr.write("error: unknown option '--force'\\n");process.exit(1)`
  const provider = createAcpConversationProvider(
    {
      id: 'old-build',
      displayName: 'Old build',
      cli: 'test',
      argv: ['-e', refuses],
      authHint: 'Run agent login in a terminal.',
      images: false,
      planMode: false,
    },
    { detect: async () => process.execPath, buildEnv: async () => ({}) },
  )
  const pending = provider.startSession({
    sessionId: 'old-build',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'old-build',
    modelId: 'default',
    workspaceRoot: tmpdir(),
  })
  await expect(pending).rejects.toThrow("unknown option '--force'")
  expect(
    looksLikePermissionSettingRefusal(
      await Promise.resolve(pending).then(
        () => '',
        (error: Error) => error.message,
      ),
    ),
  ).toBe(true)
  provider.disposeAll?.()
})
test('ACP refuses permission presets that the selected CLI cannot enforce', async () => {
  const f = await fixture()
  try {
    // The stand-in profile names no way to hold it to a preset, so it offers `none` alone.
    expect(f.provider.capabilities?.permissionPresets).toEqual(['none'])
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'bypass' })).toMatchObject({
      ok: false,
    })
    await expect(
      f.provider.startSession({ ...f.input, sessionId: 'other', permissionPreset: 'bypass' }),
    ).rejects.toThrow('cannot be held to this permission preset')
  } finally {
    await f.cleanup()
  }
})
test('ACP never upgrades an allow-once decision to a persistent agent permission', async () => {
  const f = await fixture()
  try {
    expect((await turn(f, 'broad')).find((event) => event.type === 'content_delta')?.payload?.text).toBe('Denied')
  } finally {
    await f.cleanup()
  }
})
test('ACP file helpers reject traversal, absolute escapes and symlink ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-files-'))
  try {
    await mkdir(join(root, 'workspace'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret'), 'private')
    await symlink(join(root, 'outside'), join(root, 'workspace', 'link'))
    const cwd = join(root, 'workspace')
    await expect(confinedAcpPath(cwd, '../outside/secret')).rejects.toThrow('outside')
    await expect(confinedAcpPath(cwd, join(root, 'outside', 'secret'))).rejects.toThrow('outside')
    await expect(confinedAcpPath(cwd, 'link/secret')).rejects.toThrow('Symbolic')
    await expect(confinedAcpPath(cwd, 'link/new', true)).rejects.toThrow('Symbolic')
    expect(await confinedAcpPath(cwd, 'new', true)).toBe(join(await realpath(cwd), 'new'))
    // A workspace opened through a symlinked ancestor: the agent names files
    // under the path it was started in, which is not the resolved path.
    await symlink(join(root, 'workspace'), join(root, 'alias'))
    const aliased = join(root, 'alias')
    await writeFile(join(cwd, 'file.txt'), 'inside')
    expect(await confinedAcpPath(aliased, join(aliased, 'file.txt'))).toBe(join(await realpath(cwd), 'file.txt'))
    expect(await confinedAcpPath(aliased, join(await realpath(cwd), 'file.txt'))).toBe(
      join(await realpath(cwd), 'file.txt'),
    )
    await expect(confinedAcpPath(aliased, join(aliased, 'link', 'secret'))).rejects.toThrow('Symbolic')
    await expect(confinedAcpPath(aliased, join(root, 'outside', 'secret'))).rejects.toThrow('outside')
    expect(acpToolKind('execute')).toBe('command')
    expect(acpToolKind('think')).toBe('other')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('ACP reads a subagent spawn off its tool call and keeps it an agent after the call is retitled', async () => {
  const f = await fixture()
  try {
    const started = (await turn(f, 'task')).filter((event) => event.type === 'tool_started')
    expect(started).toHaveLength(2)
    for (const event of started)
      expect(event.payload).toMatchObject({ toolUseId: 'spawn', kind: 'subagent', subagentLane: true })
    expect(started[1]?.payload).toMatchObject({ subagentType: 'explore', input: { description: 'Map the tests' } })
  } finally {
    await f.cleanup()
  }
})
async function screenshotTurn(message: string) {
  const data = await mkdtemp(join(tmpdir(), 'acp-images-'))
  const f = await fixture(false, undefined, {}, { saveToolImages: saveToolResultImagesUnder(data) })
  try {
    const events = await turn(f, message)
    const output = events.filter((event) => event.type === 'tool_output' && event.payload?.toolUseId === 'call_shot')
    const images = (output.at(-1)?.payload?.images ?? []) as string[]
    return { output, images, files: await Promise.all(images.map((path) => readFile(path, 'utf8'))) }
  } finally {
    await f.cleanup()
    await rm(data, { recursive: true, force: true })
  }
}
test('an ACP screenshot is kept as a picture on its step, once, and its output is the tool’s text', async () => {
  const { output, images, files } = await screenshotTurn('screenshot')
  expect(output).toHaveLength(1)
  expect(output[0]?.payload?.output).toBe('Captured screenshot')
  expect(JSON.stringify(output[0]?.payload)).not.toContain('base64')
  expect(images).toHaveLength(1)
  expect(images[0]).toMatch(/call_shot-1\.png$/)
  expect(files).toEqual(['not really a png'])
})
test('an ACP picture sent only as a content block is kept beside the text the step returned', async () => {
  const { output, images, files } = await screenshotTurn('screenshot blocks')
  expect(output[0]?.payload?.output).toEqual(['Captured screenshot'])
  expect(images).toHaveLength(1)
  expect(files).toEqual(['not really a png'])
})
test('an ACP raw output with a picture attachment and no text of its own keeps everything but the bytes', () => {
  const raw = {
    metadata: { title: 'Page' },
    attachments: [
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
      { type: 'file', mime: 'text/plain', url: 'file:///Users/dev/app/notes.txt' },
    ],
  }
  expect(acpRawOutputText(raw)).toEqual({
    metadata: { title: 'Page' },
    attachments: [
      { type: 'file', mime: 'image/png' },
      { type: 'file', mime: 'text/plain', url: 'file:///Users/dev/app/notes.txt' },
    ],
  })
  expect(acpRawOutputText({ output: 'plain' })).toEqual({ output: 'plain' })
  expect(acpToolResultImages([], raw)).toEqual([{ mediaType: 'image/png', base64: 'AAAA' }])
})
// What the strip above the composer reads off a turn's events, the person's
// message first as the runtime records it.
function todoProgressOf(events: ConversationEvent[], live = true) {
  const shown = [
    { ...events[0]!, type: 'user_message' as const, payload: { turnId: 'turn', text: 'plan it' } },
    ...events,
  ]
  return deriveTodoProgress(
    projectConversation(shown.map((event, index) => ({ ...event, id: `evt_${index}`, seq: index + 1 }))).entries,
    live,
  )
}
test("OpenCode's todowrite checklist is a todo call, kept one after the call is retitled, and reaches the todo strip", async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'todowrite')
    const started = events.filter((event) => event.type === 'tool_started')
    expect(started.length).toBeGreaterThan(0)
    for (const event of started) expect(event.payload).toMatchObject({ toolUseId: 'call_todo', kind: 'todo' })
    expect(started.at(-1)?.payload?.input).toMatchObject({
      todos: [{ content: 'Read the config', status: 'completed' }, {}, {}],
    })
    expect(todoProgressOf(events)).toMatchObject({
      steps: [
        { label: 'Read the config', status: 'completed' },
        { label: 'Write the test', status: 'in_progress' },
        { label: 'Run the suite', status: 'pending' },
      ],
      completed: 1,
      total: 3,
      current: 'Write the test',
    })
  } finally {
    await f.cleanup()
  }
})
test('an agent that sends a plan update beside its todowrite call shows one list, the latest', async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'todowrite plan')
    expect(events.filter((event) => event.type === 'tool_started' && event.payload?.kind === 'todo')).not.toHaveLength(
      0,
    )
    // The plan came last, with the second step ticked: the strip counts its
    // three steps, not the six of both lists.
    expect(todoProgressOf(events)).toMatchObject({ completed: 2, total: 3, current: 'Run the suite' })
  } finally {
    await f.cleanup()
  }
})
test('an ACP tool call is kept between its updates without its content or raw output', () => {
  const data = Buffer.from('not really a png').toString('base64')
  const update = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_shot',
    title: 'screenshot',
    kind: 'other',
    status: 'completed',
    rawInput: { url: 'http://localhost:5173' },
    rawOutput: { output: 'Captured', attachments: [{ type: 'file', url: `data:image/png;base64,${data}` }] },
    content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }],
    lane: { subagentLane: true },
    todo: true,
  }
  expect(acpRememberedToolCall(update)).toEqual({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_shot',
    title: 'screenshot',
    kind: 'other',
    status: 'completed',
    rawInput: { url: 'http://localhost:5173' },
    lane: { subagentLane: true },
    todo: true,
  })
  expect(update.content).toHaveLength(1)
})

test('an ACP tool call is a todo by its tool name, in either spelling', () => {
  for (const name of ['todowrite', 'TodoWrite', 'todoread', 'update_todo', ' todowrite '])
    expect(acpTodoTool(name)).toBe(true)
  for (const name of ['task', '2 todos', 'Write', '', undefined, null]) expect(acpTodoTool(name)).toBe(false)
})
test('an ACP tool call is a subagent by its spawn tool name or the agent type its input names', () => {
  expect(acpSubagentLaneFields('task', {})).toEqual({ subagentLane: true })
  expect(acpSubagentLaneFields('Task', { subagent_type: ' general ' })).toEqual({
    subagentLane: true,
    subagentType: 'general',
  })
  expect(acpSubagentLaneFields('Map the tests', { subagentType: 'explore' })).toEqual({
    subagentLane: true,
    subagentType: 'explore',
  })
  expect(acpSubagentLaneFields('Read', { path: 'a.ts' })).toEqual({})
  expect(acpSubagentLaneFields(undefined, 'task')).toEqual({})
})
test('an ACP permission request carries the locations the agent listed beside its input', () => {
  const locations = [{ path: '/Users/dev/proj/a.ts', line: 3 }]
  expect(acpApprovalInput(undefined, locations)).toEqual({ locations: [{ path: '/Users/dev/proj/a.ts' }] })
  expect(acpApprovalInput({ target_file: 'a.ts' }, locations)).toEqual({
    target_file: 'a.ts',
    locations: [{ path: '/Users/dev/proj/a.ts' }],
  })
  expect(acpApprovalInput('cat a.ts', locations)).toEqual({
    input: 'cat a.ts',
    locations: [{ path: '/Users/dev/proj/a.ts' }],
  })
  expect(acpApprovalInput({ target_file: 'a.ts' }, [])).toEqual({ target_file: 'a.ts' })
})
test("Cursor's connection diagnostic as its whole reply is a failed turn, and only that", () => {
  for (const reply of [
    'Error: RetriableError: WritableIterable is closed',
    '  Error: ConnectError: [unavailable] read ECONNRESET\n',
    'Something went wrong communicating with the server. Please try again.',
    'Error: ConnectError: [unavailable] stream closed\n    at ConnectError.from (/app/index.js:12:3)\n    at next (/app/index.js:40:9)',
    'Error: RetriableError: WritableIterable is closed\n\nSomething went wrong communicating with the server. Please try again.',
  ])
    expect(cursorTransportFailure(reply)).toBe(reply.trim())
  for (const reply of [
    '',
    'Done',
    // A reply that explains such an error is an answer.
    'The log shows Error: ConnectError: [unavailable] — the proxy dropped the stream.',
    'Error: ConnectError: [unavailable] stream closed\nI will retry the request.',
    'Error: TypeError: x is undefined',
    'Something went wrong communicating with the server. Please try again. I fixed the test anyway.',
    // Stack frames alone are not a diagnostic.
    '    at next (/app/index.js:40:9)',
  ])
    expect(cursorTransportFailure(reply)).toBeUndefined()
})

test('a Cursor turn whose reply is a connection diagnostic fails, and the next one answers as usual', async () => {
  const f = await presetFixture('cursor-agent', 'bypass')
  try {
    const diagnostic = 'Error: RetriableError: WritableIterable is closed'
    const events = await turn(f, `say ${diagnostic}`)
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', payload: { message: diagnostic } })
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false)
    expect((await turn(f, 'say Fine now')).at(-1)).toMatchObject({
      type: 'turn_completed',
      payload: { text: 'Fine now' },
    })
  } finally {
    await f.cleanup()
  }
})

test('another ACP agent replying with the same words completes its turn', async () => {
  const f = await presetFixture('opencode-agent', 'bypass')
  try {
    const events = await turn(f, 'say Error: RetriableError: WritableIterable is closed')
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' })
  } finally {
    await f.cleanup()
  }
})

test("ACP launches each preset through the CLI's own switch, and Cursor offers no Manual", () => {
  const profile = (id: string) => ACP_PROFILES.find((entry) => entry.id === id)!
  const cursor = profile('cursor-agent')
  const grok = profile('grok-agent')
  const opencode = profile('opencode-agent')
  expect(createAcpConversationProvider(cursor).capabilities?.permissionPresets).toEqual(['none', 'auto', 'bypass'])
  for (const entry of [grok, opencode])
    expect(createAcpConversationProvider(entry).capabilities?.permissionPresets).toEqual([
      'none',
      'manual',
      'auto',
      'bypass',
    ])
  // `none` passes no permission flag, so the CLI's own configuration decides.
  expect(acpLaunchArgv(cursor, 'none')).toEqual(['acp'])
  expect(acpLaunchArgv(cursor, 'auto')).toEqual(['--auto-review', 'acp'])
  expect(acpLaunchArgv(cursor, 'bypass')).toEqual(['--force', 'acp'])
  expect(acpLaunchArgv(grok, 'none')).toEqual(['agent', '--no-leader', 'stdio'])
  expect(acpLaunchArgv(grok, 'manual')).toEqual(['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'])
  expect(acpLaunchArgv(grok, 'auto')).toEqual(['--permission-mode', 'auto', 'agent', '--no-leader', 'stdio'])
  expect(acpLaunchArgv(grok, 'bypass')).toEqual(['agent', '--always-approve', '--no-leader', 'stdio'])
  // Grok's own modes, each only at the preset it sits at.
  expect(acpLaunchArgv(grok, 'auto', 'acceptEdits')).toEqual([
    '--permission-mode',
    'acceptEdits',
    'agent',
    '--no-leader',
    'stdio',
  ])
  expect(acpLaunchArgv(grok, 'manual', 'dontAsk')).toEqual([
    '--permission-mode',
    'dontAsk',
    'agent',
    '--no-leader',
    'stdio',
  ])
  expect(acpLaunchArgv(grok, 'bypass', 'acceptEdits')).toEqual(['agent', '--always-approve', '--no-leader', 'stdio'])
  expect(createAcpConversationProvider(grok).capabilities?.permissionModes).toEqual(['acceptEdits', 'dontAsk'])
  expect(createAcpConversationProvider(cursor).capabilities?.permissionModes).toEqual([])
  // `opencode acp` takes no permission flag; every preset travels in its environment.
  for (const preset of ['none', 'manual', 'auto', 'bypass'] as const)
    expect(acpLaunchArgv(opencode, preset)).toEqual(['acp'])
  expect(acpLaunchEnv(opencode, 'none')).toEqual({})
  expect(JSON.parse(acpLaunchEnv(opencode, 'bypass').OPENCODE_PERMISSION!)).toEqual({ '*': 'allow' })
  const manual = JSON.parse(acpLaunchEnv(opencode, 'manual').OPENCODE_PERMISSION!)
  const auto = JSON.parse(acpLaunchEnv(opencode, 'auto').OPENCODE_PERMISSION!)
  // The wildcard leads, so each named tool after it is the rule that wins.
  expect(Object.keys(manual)[0]).toBe('*')
  expect(manual).toMatchObject({ '*': 'ask', read: 'allow', grep: 'allow', edit: 'ask', bash: 'ask', webfetch: 'ask' })
  expect(auto).toMatchObject({ '*': 'ask', read: 'allow', edit: 'allow', bash: 'ask', external_directory: 'ask' })
})

test('an OpenCode chat and an OpenCode terminal agent are held to the same rule set for each mode', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'resources/plugins/opencode/plugin.json'), 'utf8'),
  ) as { permissionPresets: Record<string, { env?: Record<string, string> }> }
  const opencode = ACP_PROFILES.find((entry) => entry.id === 'opencode-agent')!
  for (const preset of ['manual', 'auto'] as const)
    expect(JSON.parse(manifest.permissionPresets[preset]!.env!.OPENCODE_PERMISSION!)).toEqual(
      JSON.parse(acpLaunchEnv(opencode, preset).OPENCODE_PERMISSION!),
    )
})

test('Cursor refuses Manual with the reason, rather than running it as something looser', async () => {
  const cursor = createAcpConversationProvider(
    ACP_PROFILES.find((entry) => entry.id === 'cursor-agent')!,
    {
      detect: async () => process.execPath,
      buildEnv: async () => ({}),
    },
  )
  await expect(
    cursor.startSession({
      sessionId: 'manual',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'cursor-agent',
      modelId: 'default',
      workspaceRoot: tmpdir(),
      permissionPreset: 'manual',
    }),
  ).rejects.toThrow('Cursor edits files without asking')
})

test('ACP takes a preset change mid-turn and launches the next turn under it', async () => {
  const f = await presetFixture('grok-agent', 'none')
  try {
    expect((await launched(f)).argv).toEqual(['agent', '--no-leader', 'stdio'])
    const iterator = (
      (await f.provider.sendTurn({
        ...f.input,
        turnId: 'slow',
        requestId: 'request',
        message: 'write',
      })) as AsyncIterable<ConversationEvent>
    )[Symbol.asyncIterator]()
    // The turn is running: its approval is waiting on the person.
    for (;;) {
      const next = await iterator.next()
      if (next.done || next.value.type === 'approval_requested') break
    }
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'manual' })).toEqual({
      ok: true,
      notice: 'Grok takes the new permissions from your next message.',
    })
    expect(f.provider.listLiveSessions?.()[0]).toMatchObject({ hasChildProcess: true })
    await f.provider.interrupt?.({ ...f.input })
    for (;;) if ((await iterator.next()).done) break
    expect((await launched(f)).argv).toEqual(['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'])
  } finally {
    await f.cleanup()
  }
})

test("Grok's own permission commands are refused under a stricter preset", async () => {
  const f = await presetFixture('grok-agent', 'auto')
  try {
    const events = await turn(f as Awaited<ReturnType<typeof fixture>>, '/always-approve')
    expect(events.find((event) => event.type === 'turn_failed')?.payload?.message).toContain(
      'Use the permission picker in the chat box instead.',
    )
  } finally {
    await f.cleanup()
  }
  // `/auto` is the mode Auto already starts Grok in, so only Manual refuses it.
  const manual = await presetFixture('grok-agent', 'manual')
  try {
    const events = await turn(manual as Awaited<ReturnType<typeof fixture>>, '/auto')
    expect(events.find((event) => event.type === 'turn_failed')?.payload?.message).toContain('/auto would change Grok')
  } finally {
    await manual.cleanup()
  }
})
test('ACP respawns the child with the new preset flags and reloads the same session', async () => {
  const f = await presetFixture('cursor-agent', 'none')
  try {
    expect((await launched(f)).argv).toEqual(['acp'])
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'bypass' })).toEqual({ ok: true })
    // The old child is gone at once; the flags it was launched with cannot change.
    expect(f.provider.listLiveSessions?.()[0]).toMatchObject({ hasChildProcess: false, providerSessionId: 'native' })
    expect(await launched(f)).toMatchObject({ argv: ['--force', 'acp'], opened: 'session/load' })
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
    expect((await launched(f)).argv).toEqual(['acp'])
  } finally {
    await f.cleanup()
  }
})
test('ACP launches Grok bypass with --always-approve after the agent subcommand, and Auto as its own auto mode before it', async () => {
  const f = await presetFixture('grok-agent', 'bypass')
  try {
    expect((await launched(f)).argv).toEqual(['agent', '--always-approve', '--no-leader', 'stdio'])
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'auto' })).toEqual({ ok: true })
    expect((await launched(f)).argv).toEqual(['--permission-mode', 'auto', 'agent', '--no-leader', 'stdio'])
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
    expect((await launched(f)).argv).toEqual(['agent', '--no-leader', 'stdio'])
  } finally {
    await f.cleanup()
  }
})
test('ACP gives OpenCode bypass as an allow-everything permission rule, and none leaves its config alone', async () => {
  const f = await presetFixture('opencode-agent', 'bypass')
  try {
    expect(await launched(f)).toMatchObject({ argv: ['acp'], permission: JSON.stringify({ '*': 'allow' }) })
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'manual' })).toEqual({ ok: true })
    expect(JSON.parse((await launched(f)).permission!)).toMatchObject({ '*': 'ask', edit: 'ask' })
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
    expect(await launched(f)).toMatchObject({ argv: ['acp'], permission: null })
  } finally {
    await f.cleanup()
  }
})
test('ACP under no permission flag still turns the agent permission requests into approval cards', async () => {
  const f = await presetFixture('grok-agent', 'none')
  try {
    expect((await launched(f)).argv).toEqual(['agent', '--no-leader', 'stdio'])
    await writeFile(join(f.root, 'result.txt'), 'before edit')
    const approvals = (await turn(f, 'write')).filter((event) => event.type === 'approval_requested')
    expect(approvals[0]?.payload).toMatchObject({ kind: 'tool', toolKind: 'file_edit', toolUseId: 'tool' })
    expect(await readFile(join(f.root, 'result.txt'), 'utf8')).toBe('approved write')
  } finally {
    await f.cleanup()
  }
})
test('ACP starts a session under any preset without a notice of its own', async () => {
  for (const preset of ['none', 'auto', 'bypass'] as const) {
    const f = await presetFixture('cursor-agent', preset)
    try {
      expect(f.started.some((event) => event.type === 'session_updated')).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
})

test('a model switch lands on the ACP session config before the next prompt, and default returns to its start value', async () => {
  const f = await fixture()
  try {
    expect(f.provider.capabilities?.liveModelSwitch).toBe(true)
    expect((await launched(f)).model).toBe('model-one')
    expect(await f.provider.setModel?.({ ...f.input, nextModelId: 'model-two' })).toEqual({ ok: true })
    expect((await launched(f)).model, 'the next turn runs on the new model').toBe('model-two')
    expect(await f.provider.setModel?.({ ...f.input, nextModelId: 'default' })).toEqual({ ok: true })
    expect((await launched(f)).model, 'the CLI default row maps back to the model it started on').toBe('model-one')
  } finally {
    await f.cleanup()
  }
})

test('ACP publishes the command list the agent sends outside a turn, filtered for chat, without touching turn state', async () => {
  const published: ConversationCommandCatalog[] = []
  const stop = onConversationCommandsChanged((catalog) => published.push(catalog))
  const f = await fixture(false, undefined, { STRAY: '1' })
  try {
    // The handshake's list, then the session's, which replaces it.
    const own = published.filter((catalog) => catalog.cwd === f.root && catalog.cli === 'test')
    expect(own[0]?.commands.map((command) => command.name)).toEqual(['handshake'])
    await expect.poll(() => conversationCommandsFor('test', f.root).commands.length).toBe(3)
    expect(conversationCommandsFor('test', f.root).commands).toEqual([
      { name: 'review', description: 'Review changes', argumentHint: '[commit|branch]', source: 'cli' },
      { name: 'triage', description: 'Sort the open issues.', source: 'skill' },
      { name: 'changelog', description: 'Draft a changelog entry.', source: 'custom' },
    ])
    // Text the agent streamed outside a turn is not carried into the next one.
    const events = await turn(f, 'first')
    expect(events.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text)).toEqual([
      'Done',
    ])
    expect(events.at(-1)?.type).toBe('turn_completed')
  } finally {
    stop()
    await f.cleanup()
  }
})
test('ACP replaces the published command list when the agent sends a new one', async () => {
  const f = await fixture()
  try {
    await expect.poll(() => conversationCommandsFor('test', f.root).commands.length).toBe(3)
    const events = await turn(f, '/refresh')
    expect(events.at(-1)?.type).toBe('turn_completed')
    expect(conversationCommandsFor('test', f.root).commands).toEqual([
      { name: 'fresh', description: 'Replaced list', source: 'cli' },
    ])
  } finally {
    await f.cleanup()
  }
})
test('ACP sends a leading slash command as the prompt itself, and replays lost history with the next message', async () => {
  const f = await fixture(false, 'gone')
  try {
    const ran = (await turn(f, '/review HEAD~1')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(ran).toBe('ran /review HEAD~1')
    const content = (await turn(f, 'inspect history')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(content).toContain('persisted question')
    expect(content).toContain('inspect history')
  } finally {
    await f.cleanup()
  }
})
test('ACP lists the commands an agent gives in its handshake without opening a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-probe-'))
  try {
    const commands = await probeAcpConversationCommands(
      {
        id: 'probe-acp',
        displayName: 'Test agent',
        cli: 'probe-test',
        argv: ['-e', agent],
        authHint: '',
        images: false,
        planMode: false,
      },
      { cwd: root },
      { detect: async () => process.execPath, buildEnv: async () => ({ PATH: process.env.PATH }) },
    )
    expect(commands).toEqual([{ name: 'handshake', description: 'Listed before any session', source: 'cli' }])
    expect(conversationCommandsFor('probe-test', root).commands).toEqual(commands)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Starts each child as asked, and keeps the environment it was given.
function recordingSpawn(envs: NodeJS.ProcessEnv[]): typeof spawn {
  return ((file: string, args: string[], options: SpawnOptions) => {
    envs.push(options.env ?? {})
    return spawn(file, args, options)
  }) as unknown as typeof spawn
}

const shippedAcpProfile = (id: string) => ({
  ...ACP_PROFILES.find((profile) => profile.id === id)!,
  argv: ['-e', agent],
  authenticate: undefined,
})

test("Grok's command-list handshake runs with its self-updater off, and leaves the caller's environment as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-probe-grok-'))
  const envs: NodeJS.ProcessEnv[] = []
  const callerEnv = { PATH: process.env.PATH, GROK_DISABLE_AUTOUPDATER: '0' }
  try {
    const commands = await probeAcpConversationCommands(
      shippedAcpProfile('grok-agent'),
      { cwd: root },
      { detect: async () => process.execPath, buildEnv: async () => callerEnv, spawnChild: recordingSpawn(envs) },
    )
    expect(commands?.map((command) => command.name)).toEqual(['handshake'])
    expect(envs[0]?.GROK_DISABLE_AUTOUPDATER).toBe('1')
    expect(callerEnv.GROK_DISABLE_AUTOUPDATER).toBe('0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Grok chat the person starts keeps their environment, Grok's self-updater included", async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-grok-chat-'))
  const envs: NodeJS.ProcessEnv[] = []
  const provider = createAcpConversationProvider(shippedAcpProfile('grok-agent'), {
    detect: async () => process.execPath,
    buildEnv: async () => ({ PATH: process.env.PATH }),
    spawnChild: recordingSpawn(envs),
    startupTimeoutMs: 2000,
  })
  try {
    await provider.startSession({
      sessionId: 'session',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'grok-agent',
      modelId: 'default',
      workspaceRoot: root,
    })
    expect(envs).toHaveLength(1)
    expect(envs[0]).not.toHaveProperty('GROK_DISABLE_AUTOUPDATER')
  } finally {
    provider.disposeAll?.()
    await rm(root, { recursive: true, force: true })
  }
})

for (const id of ['cursor-agent', 'opencode-agent', 'kimi-code-agent']) {
  test(`${id}'s handshake is started with nothing of Grok's set`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-probe-other-'))
    const envs: NodeJS.ProcessEnv[] = []
    try {
      await probeAcpConversationCommands(
        shippedAcpProfile(id),
        { cwd: root },
        {
          detect: async () => process.execPath,
          buildEnv: async () => ({ PATH: process.env.PATH }),
          spawnChild: recordingSpawn(envs),
        },
      )
      expect(envs).toHaveLength(1)
      expect(envs[0]).not.toHaveProperty('GROK_DISABLE_AUTOUPDATER')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("ACP opens the session with the chat's own MCP servers, and refuses one the agent cannot reach", async () => {
  const start = async (env: Record<string, string>, mcpServers: ConversationMcpServer[]) => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-'))
    const provider = createAcpConversationProvider(
      {
        id: 'test-acp',
        displayName: 'Test agent',
        cli: 'test',
        argv: ['-e', agent],
        authHint: 'Configure test agent.',
        images: true,
        planMode: true,
      },
      {
        detect: async () => process.execPath,
        buildEnv: async () => ({ PATH: process.env.PATH, ...env }),
        startupTimeoutMs: 2000,
      },
    )
    const started = Promise.resolve(
      provider.startSession({
        sessionId: 'session',
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'test-acp',
        modelId: 'default',
        workspaceRoot: root,
        mcpServers,
      }),
    )
    return { provider, root, started }
  }
  const stdio: ConversationMcpServer = {
    id: 'railway',
    name: 'Railway',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@railway/mcp'],
    env: { RAILWAY_ENV: 'prod' },
  }
  const http: ConversationMcpServer = {
    id: 'linear',
    name: 'Linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: { 'X-Team': 'acme' },
  }

  const plain = await start({}, [stdio])
  try {
    expect(createAcpConversationProvider(ACP_PROFILES[0]!).acceptsMcpServers).toBe(true)
    await plain.started
    expect(JSON.parse(await readFile(join(plain.root, 'mcp-servers.json'), 'utf8'))).toEqual([
      { name: 'railway', command: 'npx', args: ['-y', '@railway/mcp'], env: [{ name: 'RAILWAY_ENV', value: 'prod' }] },
    ])
  } finally {
    plain.provider.disposeAll?.()
    await rm(plain.root, { recursive: true, force: true })
  }

  // An agent that says nothing about HTTP servers is not handed one; the start fails with why.
  const refused = await start({}, [http])
  try {
    await expect(refused.started).rejects.toThrow(
      'Test agent does not connect to HTTP MCP servers, so it cannot run with "Linear".',
    )
    await expect(refused.started).rejects.not.toThrow('Configure test agent')
  } finally {
    refused.provider.disposeAll?.()
    await rm(refused.root, { recursive: true, force: true })
  }

  const capable = await start({ MCP_HTTP: '1' }, [http])
  try {
    await capable.started
    expect(JSON.parse(await readFile(join(capable.root, 'mcp-servers.json'), 'utf8'))).toEqual([
      { type: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'X-Team', value: 'acme' }] },
    ])
  } finally {
    capable.provider.disposeAll?.()
    await rm(capable.root, { recursive: true, force: true })
  }

  // Variables a server names are read from this app's environment, since ACP names an environment outright.
  process.env.ACP_MCP_TEST_TOKEN = 'secret-token'
  try {
    expect(
      acpMcpServers(
        [
          { ...stdio, env: undefined, envVarNames: ['ACP_MCP_TEST_TOKEN', 'ACP_MCP_TEST_UNSET'] },
          { ...http, headers: undefined, envVarNames: ['ACP_MCP_TEST_TOKEN'] },
        ],
        { http: true },
        'Test agent',
      ),
    ).toEqual([
      {
        name: 'railway',
        command: 'npx',
        args: ['-y', '@railway/mcp'],
        env: [{ name: 'ACP_MCP_TEST_TOKEN', value: 'secret-token' }],
      },
      {
        type: 'http',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
      },
    ])
  } finally {
    delete process.env.ACP_MCP_TEST_TOKEN
  }

  // An agent in WSL keeps the channel token and identity it was started with:
  // a stale one in this app's environment is not handed to its gateway.
  const gateway = {
    id: 'sprintengine-studio',
    name: 'SprintEngine Studio',
    transport: 'stdio' as const,
    command: '/home/dev/.local/share/sprintengine-studio/launcher',
    args: ['mcp'],
    env: { SPRINTENGINE_USER_DATA_DIR: '/run/user/1000/sprintengine' },
    envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN', 'SPRINTENGINE_AGENT_ID', 'ACP_MCP_TEST_TOKEN'],
  }
  const saved = {
    token: process.env.SPRINTENGINE_MCP_CHANNEL_TOKEN,
    agent: process.env.SPRINTENGINE_AGENT_ID,
  }
  process.env.SPRINTENGINE_MCP_CHANNEL_TOKEN = 'stale-token'
  process.env.SPRINTENGINE_AGENT_ID = 'stale-agent'
  process.env.ACP_MCP_TEST_TOKEN = 'secret-token'
  try {
    expect(acpMcpServers([gateway], undefined, 'Test agent', { wsl: true })).toEqual([
      {
        name: 'sprintengine-studio',
        command: '/home/dev/.local/share/sprintengine-studio/launcher',
        args: ['mcp'],
        env: [
          { name: 'SPRINTENGINE_USER_DATA_DIR', value: '/run/user/1000/sprintengine' },
          { name: 'ACP_MCP_TEST_TOKEN', value: 'secret-token' },
        ],
      },
    ])
    // On this machine the app's environment is the agent's, as before.
    expect(acpMcpServers([gateway], undefined, 'Test agent')[0]).toMatchObject({
      env: expect.arrayContaining([
        { name: 'SPRINTENGINE_MCP_CHANNEL_TOKEN', value: 'stale-token' },
        { name: 'SPRINTENGINE_AGENT_ID', value: 'stale-agent' },
      ]),
    })
  } finally {
    for (const [name, value] of [
      ['SPRINTENGINE_MCP_CHANNEL_TOKEN', saved.token],
      ['SPRINTENGINE_AGENT_ID', saved.agent],
      ['ACP_MCP_TEST_TOKEN', undefined],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('ACP branches its running session for a fork at the newest reply, and leaves any other fork to be seeded', async () => {
  const f = await fixture(false, undefined, { FORK: '1' })
  try {
    await turn(f, 'pid')
    const fork = (latest: boolean) => f.provider.fork!({ ...f.input, cursor: null, exact: false, latest })
    expect(await fork(true)).toEqual({ ok: true, cursor: { sessionId: 'branch-of-native', at: null } })
    expect(JSON.parse(await readFile(join(f.root, 'forked.json'), 'utf8'))).toMatchObject({
      sessionId: 'native',
      cwd: f.root,
    })
    // `session/fork` names no point inside the session, so an earlier one is
    // never asked of it.
    expect(await fork(false)).toEqual({ ok: true, cursor: null })
  } finally {
    await f.cleanup()
  }
  const unable = await fixture()
  try {
    expect(await unable.provider.fork!({ ...unable.input, cursor: null, exact: false, latest: true })).toEqual({
      ok: true,
      cursor: null,
    })
  } finally {
    await unable.cleanup()
  }
})

test('an ACP fork the agent could not branch hands its first message the conversation, once', async () => {
  const f = await fixture()
  try {
    const fork = {
      ...f.input,
      sessionId: 'fork-session',
      agentId: 'fork',
      seedFromHistory: true,
      fallbackHistory: [
        { role: 'user' as const, content: 'persisted question' },
        { role: 'assistant' as const, content: 'persisted answer' },
      ],
    }
    await f.provider.startSession(fork)
    const said = async (message: string) => {
      const events: ConversationEvent[] = []
      for await (const event of await f.provider.sendTurn({ ...fork, turnId: message, requestId: 'r', message }))
        events.push(event)
      return events.find((event) => event.type === 'content_delta')?.payload?.text
    }
    const first = await said('inspect history')
    expect(first).toContain('persisted answer')
    expect(first).toContain('inspect history')
    expect(await said('inspect history again')).not.toContain('persisted answer')
  } finally {
    await f.cleanup()
  }
})

test('an ACP fork whose first message the agent refused still owes the next one the conversation', async () => {
  const f = await fixture(false, undefined, { NO_IMAGES: '1' })
  try {
    const fork = {
      ...f.input,
      sessionId: 'fork-session',
      agentId: 'fork',
      seedFromHistory: true,
      fallbackHistory: [
        { role: 'user' as const, content: 'persisted question' },
        { role: 'assistant' as const, content: 'persisted answer' },
      ],
    }
    await f.provider.startSession(fork)
    const send = async (message: string, attachments?: ConversationImageAttachment[]) => {
      const events: ConversationEvent[] = []
      for await (const event of await f.provider.sendTurn({
        ...fork,
        turnId: message,
        requestId: 'r',
        message,
        ...(attachments ? { attachments } : {}),
      }))
        events.push(event)
      return events
    }
    // An image this agent does not read: the prompt carrying the conversation never goes.
    const refused = await send('inspect history first', [
      { id: 'img', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8 },
    ])
    expect(refused.some((event) => event.type === 'turn_failed')).toBe(true)
    expect(refused.some((event) => event.payload?.historySeeded === true)).toBe(false)
    const next = await send('inspect history')
    expect(next.find((event) => event.type === 'content_delta')?.payload?.text).toContain('persisted answer')
    expect(next.some((event) => event.payload?.historySeeded === true)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('an ACP session still owed its conversation is never branched: the fork is seeded instead', async () => {
  const f = await fixture(false, undefined, { FORK: '1' })
  try {
    // A fork of this chat that has not been sent anything yet: its agent's
    // session is new and empty until the first message carries the seed.
    const seeded = {
      ...f.input,
      sessionId: 'seeded-fork',
      seedFromHistory: true,
      fallbackHistory: [{ role: 'user' as const, content: 'persisted question' }],
    }
    await f.provider.startSession(seeded)
    expect(await f.provider.fork!({ ...seeded, cursor: null, exact: false, latest: true })).toEqual({
      ok: true,
      cursor: null,
    })
    await expect(readFile(join(f.root, 'forked.json'), 'utf8')).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
})

const KIMI = { KIMI_MODES: '1' }

test('Kimi Code runs No flag, Auto and Bypass as its own session modes, with no flag, and refuses Manual', () => {
  const kimi = ACP_PROFILES.find((entry) => entry.id === 'kimi-code-agent')!
  expect(kimi).toMatchObject({ cli: 'kimi-code', argv: ['acp'], images: true, planMode: true })
  expect(createAcpConversationProvider(kimi).capabilities).toMatchObject({
    permissionPresets: ['none', 'auto', 'bypass'],
    permissionModes: [],
  })
  // `kimi acp` takes no permission flag and no variable for one.
  for (const preset of ['none', 'auto', 'bypass'] as const) {
    expect(acpLaunchArgv(kimi, preset)).toEqual(['acp'])
    expect(acpLaunchEnv(kimi, preset)).toEqual({})
  }
  // Auto is Kimi's Ask When Needed (`yolo`), Bypass its Never Ask (`auto`).
  expect(acpPresetSessionMode(kimi, 'none')).toBeUndefined()
  expect(acpPresetSessionMode(kimi, 'auto')).toBe('yolo')
  expect(acpPresetSessionMode(kimi, 'bypass')).toBe('auto')
})

test('Kimi Code refuses Manual with the reason, rather than running it as something looser', async () => {
  const kimi = createAcpConversationProvider(
    ACP_PROFILES.find((entry) => entry.id === 'kimi-code-agent')!,
    {
      detect: async () => process.execPath,
      buildEnv: async () => ({}),
    },
  )
  await expect(
    kimi.startSession({
      sessionId: 'manual',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'kimi-code-agent',
      modelId: 'default',
      workspaceRoot: tmpdir(),
      permissionPreset: 'manual',
    }),
  ).rejects.toThrow('Kimi Code edits files in a git project without asking')
})

test("each Kimi Code turn puts the agent in its preset's session mode", async () => {
  const f = await presetFixture('kimi-code-agent', 'auto', KIMI)
  try {
    expect(await launched(f)).toMatchObject({ mode: 'yolo' })
  } finally {
    await f.cleanup()
  }
  const none = await presetFixture('kimi-code-agent', 'none', KIMI)
  try {
    // No flag is the mode Kimi opened the session in.
    expect(await launched(none)).toMatchObject({ mode: 'default' })
  } finally {
    await none.cleanup()
  }
})

test("a Kimi Code chat's Plan turn runs in Kimi's plan mode, whatever the preset", async () => {
  const f = await presetFixture('kimi-code-agent', 'bypass', KIMI)
  try {
    const events: ConversationEvent[] = []
    for await (const event of await f.provider.sendTurn({
      ...f.input,
      turnId: 'plan',
      requestId: 'request',
      message: 'argv',
      mode: 'plan',
    }))
      events.push(event)
    const said = events.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text)
    expect(JSON.parse(said.join(''))).toMatchObject({ mode: 'plan' })
  } finally {
    await f.cleanup()
  }
})

test('a Kimi Code preset change between turns keeps the process and moves the session mode', async () => {
  const f = await presetFixture('kimi-code-agent', 'none', KIMI)
  try {
    const first = await launched(f)
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'bypass' })).toEqual({ ok: true })
    expect(f.provider.listLiveSessions?.()[0]).toMatchObject({ hasChildProcess: true })
    expect(await launched(f)).toMatchObject({ pid: first.pid, mode: 'auto', opened: 'session/new' })
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
    expect(await launched(f)).toMatchObject({ pid: first.pid, mode: 'default' })
  } finally {
    await f.cleanup()
  }
})

test('a Kimi Code preset change mid-turn moves the running turn to the new session mode', async () => {
  const f = await presetFixture('kimi-code-agent', 'none', KIMI)
  try {
    const iterator = (
      (await f.provider.sendTurn({
        ...f.input,
        turnId: 'slow',
        requestId: 'request',
        message: 'wait then mode',
      })) as AsyncIterable<ConversationEvent>
    )[Symbol.asyncIterator]()
    let requestId = ''
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'approval_requested') {
        requestId = String(next.value.payload?.requestId)
        break
      }
    }
    // No "from your next message": the mode is the agent's now.
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'auto' })).toEqual({ ok: true })
    await f.provider.resolveApproval({ ...f.input, turnId: 'slow', requestId, approved: true })
    let said = ''
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'content_delta') said += String(next.value.payload?.text ?? '')
    }
    expect(said).toBe('yolo')
  } finally {
    await f.cleanup()
  }
})

test('a Kimi Code build without the mode a preset runs in fails the turn as a refused setting', async () => {
  const f = await presetFixture('kimi-code-agent', 'auto', { KIMI_MODES: '-yolo' })
  try {
    const failed = (await turn(f as Awaited<ReturnType<typeof fixture>>, 'argv')).find(
      (event) => event.type === 'turn_failed',
    )
    const message = String(failed?.payload?.message)
    expect(message).toContain('yolo session mode')
    // So the runtime starts the chat again with no preset, as for a refused flag.
    expect(looksLikePermissionSettingRefusal(message)).toBe(true)
  } finally {
    await f.cleanup()
  }
})
