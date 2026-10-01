export const PACKAGE_NAME = '@unicontext/mcp';

export {
  createMcpServer,
  DEFAULT_MCP_VERSION,
  HOW_TO_CONFIRM,
  MCP_SERVER_NAME,
  SERVER_INSTRUCTIONS,
  type McpDeps,
} from './server.js';
export { handleMcpHttp, runStdioServer } from './transports.js';
export {
  applyProposal,
  DEFAULT_PROPOSAL_TTL_MS,
  ProposalStore,
  type CreateProposalInput,
  type Proposal,
  type ProposalStatus,
} from './proposals.js';
export {
  buildAssignments,
  OPEN_TASK_STATUSES,
  type AssignmentFilter,
  type AssignmentItem,
} from './assignments.js';
export { buildEnvelope, collect, type EnvelopeOptions, type McpEnvelope } from './envelope.js';
export { listCourses, resolveCourse, type ResolvedCourse } from './courses.js';
