// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  A2AServer,
  InMemoryA2ATransport,
  JSON_RPC_ERRORS,
  MockA2APeer,
  defaultAgentCard,
  textMessage,
  type AgentCard,
} from '../src/a2a.js';

const card: AgentCard = defaultAgentCard('http://localhost:3000/api/protocols/a2a');

describe('agent card', () => {
  it('has the well-known shape', () => {
    expect(card.name).toBeTruthy();
    expect(card.url).toBe('http://localhost:3000/api/protocols/a2a');
    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.skills.length).toBeGreaterThan(0);
    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
    }
  });
});

describe('A2A task lifecycle', () => {
  it('runs submitted → working → completed with the handler artifact', async () => {
    const seen: string[] = [];
    const server = new A2AServer({
      card,
      handler: async (message, task) => {
        seen.push(task.status); // must already be 'working'
        return { reply: message.parts[0]?.text };
      },
    });
    const task = server.createTask(textMessage('hello'));
    expect(task.status).toBe('submitted');
    await server.runTask(task);
    expect(seen).toEqual(['working']);
    expect(task.status).toBe('completed');
    expect(task.artifact).toEqual({ reply: 'hello' });
    expect(task.history.map((h) => h.status)).toEqual(['submitted', 'working', 'completed']);
  });

  it('marks the task failed when the handler throws', async () => {
    const server = new A2AServer({
      card,
      handler: async () => {
        throw new Error('boom');
      },
    });
    const task = server.createTask(textMessage('x'));
    await server.runTask(task);
    expect(task.status).toBe('failed');
    expect(task.error?.message).toBe('boom');
  });

  it('cancels a non-terminal task and refuses terminal ones', () => {
    const server = new A2AServer({ card });
    const task = server.createTask(textMessage('x'));
    server.cancelTask(task.id);
    expect(task.status).toBe('canceled');
    expect(() => server.cancelTask(task.id)).toThrow(/already terminal/);
    expect(() => server.cancelTask('nope')).toThrow(/unknown task/);
  });
});

describe('A2A JSON-RPC', () => {
  function server() {
    return new A2AServer({ card });
  }

  it('message/send runs the task and returns the completed wire task', async () => {
    const transport = new InMemoryA2ATransport(server());
    const result = (await transport.call('message/send', {
      message: textMessage('ping'),
    })) as { id: string; status: { state: string } };
    expect(result.status.state).toBe('completed');
    expect(typeof result.id).toBe('string');
  });

  it('tasks/get returns a task by id', async () => {
    const s = server();
    const transport = new InMemoryA2ATransport(s);
    const created = (await transport.call('message/send', { message: textMessage('hi') })) as { id: string };
    const got = (await transport.call('tasks/get', { id: created.id })) as { id: string };
    expect(got.id).toBe(created.id);
  });

  it('rejects unknown methods with -32601', async () => {
    const transport = new InMemoryA2ATransport(server());
    const res = await transport.raw({ jsonrpc: '2.0', id: 1, method: 'nope/nothing' });
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
  });

  it('rejects malformed requests with -32600', async () => {
    const transport = new InMemoryA2ATransport(server());
    const res = await transport.raw({ jsonrpc: '2.0', id: 2 } as never);
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
  });

  it('rejects bad params with -32602', async () => {
    const transport = new InMemoryA2ATransport(server());
    const res = await transport.raw({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: {} });
    expect(res.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });
});

describe('MockA2APeer round-trip', () => {
  it('echoes through the in-memory transport', async () => {
    const peer = new MockA2APeer();
    const transport = peer.transport();
    const result = (await transport.call('message/send', {
      message: textMessage('summarize this'),
    })) as { status: { state: string } };
    expect(result.status.state).toBe('completed');
    expect(peer.received).toHaveLength(1);
    expect(peer.received[0]?.parts[0]?.text).toBe('summarize this');
  });

  it('surfaces peer failures as failed tasks', async () => {
    const peer = new MockA2APeer();
    const result = (await peer.transport().call('message/send', {
      message: textMessage('please FAIL this one'),
    })) as { status: { state: string }; error: { message: string } };
    expect(result.status.state).toBe('failed');
    expect(result.error.message).toMatch(/simulated failure/);
  });
});
