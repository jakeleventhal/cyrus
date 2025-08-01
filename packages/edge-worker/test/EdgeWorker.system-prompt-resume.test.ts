import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EdgeWorker } from '../src/EdgeWorker.js'
import type { EdgeWorkerConfig, RepositoryConfig } from '../src/types.js'
import { readFile } from 'fs/promises'
import { LinearClient } from '@linear/sdk'
import { ClaudeRunner } from 'cyrus-claude-runner'
import { NdjsonClient } from 'cyrus-ndjson-client'
import { SharedApplicationServer } from '../src/SharedApplicationServer.js'
import { AgentSessionManager } from '../src/AgentSessionManager.js'
import type { LinearAgentSessionCreatedWebhook, LinearAgentSessionPromptedWebhook } from 'cyrus-core'
import { isAgentSessionCreatedWebhook, isAgentSessionPromptedWebhook } from 'cyrus-core'

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn()
}))

// Mock dependencies
vi.mock('cyrus-ndjson-client')
vi.mock('cyrus-claude-runner')
vi.mock('@linear/sdk')
vi.mock('../src/SharedApplicationServer.js')
vi.mock('../src/AgentSessionManager.js')
vi.mock('cyrus-core', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    isAgentSessionCreatedWebhook: vi.fn(),
    isAgentSessionPromptedWebhook: vi.fn(),
    PersistenceManager: vi.fn().mockImplementation(() => ({
      loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
      saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined)
    }))
  }
})
vi.mock('file-type')

describe('EdgeWorker - System Prompt Resume', () => {
  let edgeWorker: EdgeWorker
  let mockConfig: EdgeWorkerConfig
  let mockLinearClient: any
  let mockClaudeRunner: any
  let mockAgentSessionManager: any
  let capturedClaudeRunnerConfig: any = null

  const mockRepository: RepositoryConfig = {
    id: 'test-repo',
    name: 'Test Repo',
    repositoryPath: '/test/repo',
    workspaceBaseDir: '/test/workspaces',
    baseBranch: 'main',
    linearToken: 'test-token',
    linearWorkspaceId: 'test-workspace',
    isActive: true,
    allowedTools: ['Read', 'Edit'],
    labelPrompts: {
      debugger: ['bug', 'error'],
      builder: ['feature', 'enhancement'],
      scoper: ['scope', 'research']
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    
    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock LinearClient
    mockLinearClient = {
      issue: vi.fn().mockResolvedValue({
        id: 'issue-123',
        identifier: 'TEST-123',
        title: 'Test Issue with Bug',
        description: 'This is a bug that needs fixing',
        url: 'https://linear.app/test/issue/TEST-123',
        branchName: 'test-branch',
        state: { name: 'Todo' },
        team: { id: 'team-123' },
        labels: vi.fn().mockResolvedValue({
          nodes: [{ name: 'bug' }] // This should trigger debugger prompt
        })
      }),
      workflowStates: vi.fn().mockResolvedValue({
        nodes: [
          { id: 'state-1', name: 'Todo', type: 'unstarted', position: 0 },
          { id: 'state-2', name: 'In Progress', type: 'started', position: 1 }
        ]
      }),
      updateIssue: vi.fn().mockResolvedValue({ success: true }),
      createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
      comments: vi.fn().mockResolvedValue({ nodes: [] })
    }
    vi.mocked(LinearClient).mockImplementation(() => mockLinearClient)

    // Mock ClaudeRunner to capture config
    mockClaudeRunner = {
      startStreaming: vi.fn().mockResolvedValue({ sessionId: 'claude-session-123' }),
      stop: vi.fn(),
      isStreaming: vi.fn().mockReturnValue(false),
      addStreamMessage: vi.fn(),
      updatePromptVersions: vi.fn()
    }
    vi.mocked(ClaudeRunner).mockImplementation((config: any) => {
      capturedClaudeRunnerConfig = config
      return mockClaudeRunner
    })

    // Mock AgentSessionManager
    mockAgentSessionManager = {
      createLinearAgentSession: vi.fn(),
      getSession: vi.fn().mockReturnValue({
        claudeSessionId: 'claude-session-123',
        workspace: { path: '/test/workspaces/TEST-123' },
        claudeRunner: mockClaudeRunner
      }),
      addClaudeRunner: vi.fn(),
      getAllClaudeRunners: vi.fn().mockReturnValue([]),
      serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
      restoreState: vi.fn()
    }
    vi.mocked(AgentSessionManager).mockImplementation(() => mockAgentSessionManager)

    // Mock SharedApplicationServer
    vi.mocked(SharedApplicationServer).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      registerOAuthCallbackHandler: vi.fn()
    } as any))

    // Mock NdjsonClient
    vi.mocked(NdjsonClient).mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      on: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true)
    } as any))

    // Mock type guards
    vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(false)
    vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false)

    // Mock readFile to return debugger prompt
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (path.includes('debugger.md')) {
        return `<version-tag value="debugger-v1.0.0" />
# Debugger System Prompt

You are in debugger mode. Fix bugs systematically.`
      }
      // Return default prompt template
      return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`
    })

    mockConfig = {
      proxyUrl: 'http://localhost:3000',
      repositories: [mockRepository],
      handlers: {
        createWorkspace: vi.fn().mockResolvedValue({
          path: '/test/workspaces/TEST-123',
          isGitWorktree: false
        })
      }
    }

    edgeWorker = new EdgeWorker(mockConfig)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should include system prompt when creating initial ClaudeRunner', async () => {
    // Arrange
    const createdWebhook: LinearAgentSessionCreatedWebhook = {
      type: 'Issue',
      action: 'agentSessionCreated',
      organizationId: 'test-workspace',
      agentSession: {
        id: 'agent-session-123',
        issue: {
          id: 'issue-123',
          identifier: 'TEST-123',
          team: { key: 'TEST' }
        }
      }
    }

    vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true)
    
    // Act - call the private method directly since we're testing internal behavior
    const handleAgentSessionCreatedWebhook = (edgeWorker as any).handleAgentSessionCreatedWebhook.bind(edgeWorker)
    await handleAgentSessionCreatedWebhook(createdWebhook, mockRepository)

    // Assert
    expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled()
    expect(capturedClaudeRunnerConfig).toBeDefined()
    expect(capturedClaudeRunnerConfig.appendSystemPrompt).toContain('You are in debugger mode. Fix bugs systematically.')
    expect(capturedClaudeRunnerConfig.appendSystemPrompt).toContain('___LAST_MESSAGE_MARKER___')
  })

  it('should include system prompt when resuming ClaudeRunner (bug fixed)', async () => {
    // Reset mocks
    vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(false)
    vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(true)
    capturedClaudeRunnerConfig = null

    // Arrange
    const promptedWebhook: LinearAgentSessionPromptedWebhook = {
      type: 'Issue',
      action: 'agentSessionPrompted',
      organizationId: 'test-workspace',
      agentSession: {
        id: 'agent-session-123',
        issue: {
          id: 'issue-123',
          identifier: 'TEST-123',
          team: { key: 'TEST' }
        }
      },
      agentActivity: {
        content: {
          type: 'user',
          body: 'Please fix this bug'
        }
      }
    }

    // Act - call the private method directly
    const handleUserPostedAgentActivity = (edgeWorker as any).handleUserPostedAgentActivity.bind(edgeWorker)
    await handleUserPostedAgentActivity(promptedWebhook, mockRepository)

    // Assert - Bug is now fixed: system prompt is included!
    expect(vi.mocked(ClaudeRunner)).toHaveBeenCalled()
    expect(capturedClaudeRunnerConfig).toBeDefined()
    // System prompt should include BOTH the debugger prompt AND the marker
    expect(capturedClaudeRunnerConfig.appendSystemPrompt).toContain('You are in debugger mode. Fix bugs systematically.')
    expect(capturedClaudeRunnerConfig.appendSystemPrompt).toContain('___LAST_MESSAGE_MARKER___')
  })

})