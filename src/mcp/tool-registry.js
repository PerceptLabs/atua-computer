export function createMcpToolRegistry(runtime, options = {}) {
  const metadata = {
    transport: options.transport || 'in-process',
    authzEnabled: Boolean(options.authzEnabled),
    schemaVersion: options.schemaVersion || null,
  };

  const tools = {
    runtime_boot: {
      description: 'Boot the runtime',
      inputSchema: {
        type: 'object',
        properties: {
          overlay: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      handler: async (input = {}) => {
        await runtime.boot({ overlay: input.overlay || {} });
        return { ok: true };
      },
    },
    runtime_exec: {
      description: 'Execute a command in runtime',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
      handler: async ({ command }) => runtime.exec(command),
    },
    runtime_service: {
      description: 'Manage services in runtime',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'] },
          name: { type: 'string' },
          command: { type: 'string' },
        },
        required: ['action', 'name'],
      },
      handler: async ({ action, name, command }) => runtime.service(action, name, { command }),
    },
    runtime_checkpoint: {
      description: 'Create checkpoint',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
        },
      },
      handler: async ({ label } = {}) => ({ id: await runtime.checkpoint(label) }),
    },
    runtime_restore: {
      description: 'Restore checkpoint',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      handler: async ({ id }) => {
        await runtime.restore(id);
        return { ok: true };
      },
    },
    runtime_status: {
      description: 'Get runtime status',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => runtime.status(),
    },
  };

  return {
    metadata() {
      return { ...metadata };
    },
    listTools() {
      return Object.entries(tools).map(([name, value]) => ({
        name,
        description: value.description,
        inputSchema: value.inputSchema,
      }));
    },
    async invoke(name, input = {}) {
      const tool = tools[name];
      if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
      return tool.handler(input);
    },
  };
}
