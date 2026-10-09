// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { AcpClient, AcpError, acpOptionsFromBot } from '../src/acp.js';

/**
 * Mock ACP agent: a node one-liner speaking the minimal protocol over stdio.
 * Responds to initialize and prompt; records nothing.
 */
const MOCK_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent' } } }) + '\\n');
  } else if (msg.method === 'prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text: 'mock result for: ' + msg.params.prompt } }) + '\\n');
  }
  // cancel notifications ignored
});
`;

describe('AcpClient', () => {
  it('connects and runs initialize', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT] });
    try {
      const info = await client.connect();
      expect(info.agentName).toBe('mock-agent');
    } finally {
      client.close();
    }
  });

  it('prompt returns the agent text', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT] });
    try {
      await client.connect();
      const text = await client.prompt('write hello world');
      expect(text).toBe('mock result for: write hello world');
    } finally {
      client.close();
    }
  });

  it('cancel is a best-effort notification (no throw)', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT] });
    try {
      await client.connect();
      expect(() => client.cancel('sess-1')).not.toThrow();
    } finally {
      client.close();
    }
  });

  it('fails clearly on unknown command', async () => {
    const client = new AcpClient({ command: 'definitely-not-a-real-binary-xyz' });
    await expect(client.connect()).rejects.toThrow(AcpError);
    client.close();
  });

  it('rejects empty command', () => {
    expect(() => new AcpClient({ command: '  ' })).toThrow(AcpError);
  });

  it('prompt before connect rejects', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT] });
    await expect(client.prompt('hi')).rejects.toThrow(/not connected/);
    client.close();
  });
});

describe('acpOptionsFromBot', () => {
  it('returns null when no acp config', () => {
    expect(acpOptionsFromBot(undefined)).toBeNull();
    expect(acpOptionsFromBot({})).toBeNull();
    expect(acpOptionsFromBot({ acp: { command: '  ' } })).toBeNull();
  });

  it('parses command and args', () => {
    expect(acpOptionsFromBot({ acp: { command: 'opencode', args: ['acp', '--x'] } })).toEqual({
      command: 'opencode',
      args: ['acp', '--x'],
    });
  });
});
