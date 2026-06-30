import { startMcpServer } from './server.js';

startMcpServer().catch((error) => {
  console.error('MCP server failed:', error);
  process.exit(1);
});
