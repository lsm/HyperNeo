# Performance Hotspots in HyperNeo Codebase

## Executive Summary

This research identifies potential performance bottlenecks in the HyperNeo browser UI for the Claude Agent SDK. The analysis reveals hotspots across three primary areas: database operations, reactive query patterns, and frontend rendering patterns.

## Methodology

- Static code analysis focusing on largest files by line count
- Identification of async operations and iteration patterns  
- Analysis of database query patterns and indexing strategies
- Examination of reactive state management and LiveQuery implementations
- Review of component complexity and frontend reactivity patterns

## Critical Performance Hotspots

### 1. Space Runtime Core (9,586 lines)
**Location:** `packages/daemon/src/lib/space/runtime/space-runtime.ts`

**Issues:**
- **Tick Loop Complexity**: Central orchestration engine managing workflow run lifecycles with continuous re-evaluation
- **Agent Lifecycle Management**: Spawning, monitoring, and recovering from agent crashes
- **Database Transaction Overhead**: Frequent DB operations for workflow state persistence
- **Pending Message Queue**: Persistent queue processing for workflow agent handoffs

**Impact:** High - This is the core execution engine for all Space workflows

**Evidence:**
- File contains extensive tick loop logic, executor management, and state reconciliation
- Queue management and workflow execution coordination patterns
- 9,586 lines indicates significant complexity in a single module

### 2. Live Query System (4,197 lines)  
**Location:** `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`

**Issues:**
- **Query Re-evaluation Burden**: All dependent queries re-evaluated on table changes
- **Scope Filtering Overhead**: While scope filters exist, they require per-subscription evaluation
- **Debounce Management**: Multiple debounced queries with varying delays (100-250ms)
- **Row Mapping Complexity**: Extensive row transformation operations per query evaluation

**Impact:** High - Affects all real-time UI updates

**Evidence:**
```typescript
const DEBOUNCE_SDK_MESSAGES_MS = 100;
const DEBOUNCE_SESSION_LIST_MS = 150;
const DEBOUNCE_SPACE_TASK_FEEDS_MS = 250;
```
- NamedQuery registry with complex mapRow and mapResult functions
- Per-query result caching with hash-based change detection

### 3. Task Agent Manager (5,909 lines)
**Location:** `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`

**Issues:**
- **Message Queue Drain Operations**: Frequent pending message queue processing
- **Agent Session Management**: Complex lifecycle management for task agent sessions
- **Database Operations**: Extensive use of reactive database patterns
- **Tick-based Processing**: Continuous tick loop for task state management

**Impact:** High - Core task processing and agent interaction layer

**Evidence:**
- 5,909 lines in single file suggests complexity
- Multiple repository integrations and database access patterns
- Message routing and queue processing logic

### 4. Space Agent Tools (5,835 lines)
**Location:** `packages/daemon/src/lib/space/tools/space-agent-tools.ts`

**Issues:**
- **Tool Resolution**: Extensive tool matching and routing logic
- **MCP Server Integration**: Multiple MCP server interactions
- **Question Building**: Complex prompt construction and response handling
- **Message Routing**: Sophisticated message delivery and queuing logic

**Impact:** Medium - Tool invocation overhead for each agent action

## Database Performance Patterns

### Indexing Strategy
The codebase shows evidence of performance-conscious database design with numerous indexes:

**Evolution Tables:**
```sql
CREATE INDEX idx_evolution_scopes_space ON evolution_scopes(space_id, updated_at DESC)
CREATE INDEX idx_evolution_evidence_scope_created ON evolution_evidence(scope_id, created_at DESC)
CREATE INDEX idx_evolution_episodes_scope_status ON evolution_episodes(scope_id, status, updated_at DESC)
```

**Long-Horizon Agents:**
```sql
CREATE INDEX idx_space_long_horizon_agents_space_status ON space_long_horizon_agents(space_id, status)
CREATE INDEX idx_space_lh_agent_reminders_due ON space_long_horizon_agent_reminders(due_at)
```

### N+1 Query Prevention
Evidence of conscious N+1 prevention in repository patterns:
- `space-task-repository.ts`: "Uses a single SQL query with IN clause to avoid N+1 lookups"
- `workflow-run-artifact-repository.ts`: "Used to collapse N+1 lookups in buildPreflightContext"

## Frontend Performance Hotspots

### 1. Space Overview Component
**Location:** `packages/web/src/components/space/SpaceOverview.tsx`

**Characteristics:**
- Reactive state management with Preact signals
- Multiple computed values for task statistics
- Real-time updates via LiveQuery subscriptions
- Runtime control interactions

**Performance Considerations:**
- Task count calculations across different states
- Recent tasks feed updates
- Session list management

### 2. Space Store State Management
**Location:** `packages/web/src/lib/space-store.ts`

**Characteristics:**
- Pure WebSocket architecture (no REST API fallback)
- Extensive use of Preact signals for reactive state
- LiveQuery delta event processing
- Promise-chain locks for atomic operations

**Signals Managed:**
```typescript
readonly spaces = signal<Space[]>([]);
readonly tasks = signal<SpaceTask[]>([]);
readonly workflowRuns = signal<SpaceWorkflowRun[]>([]);
readonly agents = signal<SpaceWorkerAgent[]>([]);
// ... 15+ additional signals
```

### 3. Large Component Files
**Heaviest Components:**
- `MinimalThreadFeed.tsx`: 2,806 lines (plus 4,096 lines of tests)
- `SpaceForge.tsx`: 2,153 lines
- `SpaceTaskPane.tsx`: 1,728 lines (plus 2,260 lines of tests)

These large components suggest complex rendering logic that could benefit from decomposition.

## Query and Iteration Patterns

### Async Operations Density
Space runtime code shows significant async operation density:
- **722 instances** of iteration patterns (`forEach`, `for...of`, `filter`, `map`, `reduce`) in space runtime
- Extensive Promise/await patterns throughout agent and workflow code
- Database transaction usage pattern: `db.transaction(() => {...})`

### Live Query Cache Management
**Location:** `packages/daemon/src/storage/live-query.ts`

**Performance Features:**
- Per-query result caching with hash-based change detection
- Row-level hash caching for diff computation
- Metadata caching separate from row data
- Scope filtering to skip irrelevant table changes

**Cache Structure:**
```typescript
interface QueryEntry<T> {
  cachedRows: T[];
  cachedHash: number;
  cachedRowHashes: Map<unknown, number> | null;
  cachedMetadata: Record<string, unknown> | undefined;
  subscribers: Set<Subscriber<T>>;
  pendingEval: boolean;
  debounceMs: number;
  scopeFilter: ((scope: TableChangeScope) => boolean) | undefined;
}
```

## External Event Processing

### GitHub Event Extension (4,601 lines)
**Location:** `packages/daemon/src/lib/external-events/github/github-event-extension.ts`

**Characteristics:**
- Large, complex event handling system
- PR event processing and state management
- Webhook payload processing
- Event delivery queue management

## Optimization Opportunities

### 1. Database Query Consolidation
**Priority:** High
**Impact:** Could reduce database load and improve workflow tick performance

**Opportunity:** The existing N+1 prevention patterns show awareness, but consolidation opportunities may remain in complex workflow operations.

**Recommendation:** Audit workflow run artifact retrieval patterns for batch operation potential.

### 2. Live Query Scope Filtering
**Priority:** High  
**Impact:** Reduced re-evaluation overhead for high-frequency queries

**Opportunity:** Scope filters exist but may not be optimally configured for all high-frequency queries.

**Recommendation:** Review the 100-250ms debounce settings and scope filter implementations for task feeds and message queries.

### 3. Component Decomposition
**Priority:** Medium
**Impact:** Improved frontend rendering performance and maintainability

**Opportunity:** Large frontend components (2,000+ lines) suggest complexity that could impact rendering performance.

**Recommendation:** Consider decomposing `MinimalThreadFeed` and `SpaceForge` into smaller, more focused components with memoization boundaries.

### 4. Agent Lifecycle Caching
**Priority:** Medium
**Impact:** Reduced agent spawn overhead in workflow operations

**Opportunity:** Frequent agent spawning and recovery operations in space runtime.

**Recommendation:** Implement agent session pooling or caching patterns for frequently used agent configurations.

### 5. Message Queue Batching
**Priority:** Medium
**Impact:** Reduced processing overhead for message delivery

**Opportunity:** Individual message processing in task agent manager.

**Recommendation:** Implement batch processing for pending message queue drain operations.

## Performance Monitoring Gaps

### Missing Instrumentation
- No performance monitoring hooks identified in core runtime paths
- Absence of timing metrics for workflow tick execution
- No query performance tracking in LiveQuery system
- Limited frontend render performance monitoring

**Recommendation:** Add performance monitoring to critical paths:
- Workflow tick duration
- LiveQuery evaluation time
- Component render cycles
- Agent spawn time

## Database Performance Observations

### SQLite Optimization
The codebase shows evidence of SQLite performance tuning:
- Synchronous mode set to NORMAL for durability/performance balance
- Comprehensive indexing strategy across space tables
- Use of transactions for atomic operations

### Migration Performance
Evidence of performance-focused migrations:
- "Migration 72: Add missing performance indexes for rooms, sessions, and goals tables"
- Index additions for evolution scopes and evidence tables

## Limitations and Future Research

### Analysis Limitations
- **Static Analysis Only**: No runtime profiling or performance measurements
- **Complexity Metrics**: File size used as proxy for complexity (imperfect measure)
- **Lack of Baseline**: No established performance benchmarks for comparison
- **Component Interaction**: Limited understanding of runtime component interaction patterns

### Recommended Empirical Research
1. **Runtime Profiling**: Add performance instrumentation to workflow tick loops
2. **Database Query Analysis**: Use SQLite EXPLAIN QUERY PLAN on hot queries
3. **Frontend Profiling**: Use React DevTools Profiler to measure render cycles
4. **Load Testing**: Performance testing under concurrent workflow execution
5. **Memory Profiling**: Identify memory leaks or excessive allocation patterns

## Conclusion

The HyperNeo codebase demonstrates performance-conscious architecture with caching, indexing, and N+1 prevention patterns. However, several hotspots emerge from static analysis:

1. **Space Runtime Core**: Complex tick loop with frequent DB operations (9,586 lines)
2. **Live Query System**: High-frequency re-evaluation with debouncing (4,197 lines)
3. **Task Agent Manager**: Continuous message queue processing (5,909 lines)
4. **Large Components**: Frontend rendering complexity (2,000+ line components)

The most impactful optimization opportunities based on code analysis are:
- Workflow tick execution optimization and DB query consolidation
- Live query scope filter refinement and debouncing tuning  
- Agent lifecycle caching and session pooling
- Component decomposition with memoization boundaries

The existing patterns show good performance awareness, suggesting these optimizations would fit naturally into the current architecture. However, empirical validation through runtime profiling is recommended to confirm impact rankings and guide prioritization.

## Sources

- Static code analysis of HyperNeo monorepo (August 2026)
- Database schema analysis: `packages/daemon/src/storage/schema/`
- Runtime implementation: `packages/daemon/src/lib/space/runtime/`
- Frontend components: `packages/web/src/components/space/`
- Live query implementation: `packages/daemon/src/storage/live-query.ts`
- File size analysis: `find` and `wc` commands across packages
- Grep analysis for async patterns, database operations, and reactive signals