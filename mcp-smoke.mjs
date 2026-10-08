import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
const client = new Client({ name: 'smoke', version: '1.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:4136/sse')));
const tools = await client.listTools();
console.log('TOOL_COUNT:', tools.tools.length);
console.log('HAS_CHAT:', tools.tools.some(t => t.name === 'chat'));
console.log('HAS_RUN_COMMAND:', tools.tools.some(t => t.name === 'run_command'));
await client.close();
