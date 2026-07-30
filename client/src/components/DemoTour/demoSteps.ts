export type DemoView = 'projects' | 'tasks' | 'agent';

export interface DemoStepDefinition {
  id: string;
  selector: string;
  view?: DemoView;
  title: string;
  description: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** When true, App sets the agent demo prompt before this step highlights. */
  prefillAgentPrompt?: boolean;
  /** Run before highlighting — e.g. ensure a project is selected. */
  prepare?: 'selectFirstProject';
}

export const DEMO_AGENT_PROMPT =
  'Create three onboarding tasks: Plan the work, Build the feature, Review and ship.';

export const DEMO_STEPS: DemoStepDefinition[] = [
  {
    id: 'views',
    selector: '[data-demo-step="header-views"]',
    title: 'Three main views',
    description:
      'Switch between Agent (AI assistant), Projects (workspaces), and Tasks (your work items). Most of your day flows through these three views.',
    side: 'bottom',
  },
  {
    id: 'projects',
    selector: '[data-demo-step="add-project"]',
    view: 'projects',
    title: 'Create projects',
    description:
      'Use + Add project for a root workspace, or + Add sub project under an existing one. Click a project in the tree to make it your active project.',
    side: 'right',
  },
  {
    id: 'current-project',
    selector: '[data-demo-step="current-project"]',
    view: 'projects',
    title: 'Active project',
    description:
      'The Current project label shows what Agent and Tasks are scoped to. Select a different project in the tree to switch context.',
    side: 'bottom',
  },
  {
    id: 'share-members',
    selector: '[data-demo-step="project-members"]',
    view: 'projects',
    prepare: 'selectFirstProject',
    title: 'Share a project',
    description:
      'As the project owner, open Members to invite collaborators. Choose someone from the Recent collaborator dropdown or enter a new email on the same form — they can join even without an existing account. Choose a role: Manager can create sub-projects and edit structure but cannot delete or manage members; Editor can create and edit tasks; Executor updates status only; Viewer is read-only. Invites must be accepted before access is granted.',
    side: 'right',
  },
  {
    id: 'share-notifications',
    selector: '[data-demo-step="notification-bell"]',
    title: 'Accept invites',
    description:
      'Pending invites appear in the notification bell and as a banner when you sign in. Accept to join a shared project; your role determines what you can edit.',
    side: 'bottom',
  },
  {
    id: 'tasks',
    selector: '[data-demo-step="add-task"]',
    view: 'tasks',
    title: 'Add tasks and subtasks',
    description:
      'Click + Add task to create work in the active project. Select an item and use + Add subtask to break work down further.',
    side: 'right',
  },
  {
    id: 'agent',
    selector: '[data-demo-step="agent-input"]',
    view: 'agent',
    prefillAgentPrompt: true,
    title: 'Ask the Agent',
    description:
      'We pre-filled a sample prompt. Click Send to see the agent propose new tasks. Write actions need your approval before they apply (unless auto-approve is on).',
    side: 'top',
  },
  {
    id: 'approval',
    selector: '[data-demo-step="agent-panel"]',
    view: 'agent',
    title: 'Review proposals',
    description:
      'After you send a message, write actions appear in a Pending approval bar at the bottom of this panel. Approve or reject before changes apply (unless auto-approve is on).',
    side: 'top',
  },
  {
    id: 'search',
    selector: '[data-demo-step="header-search"]',
    title: 'Search everything',
    description:
      'Type here or press ⌘K (Ctrl+K on Windows/Linux) to search tasks, projects, and checklist steps by meaning.',
    side: 'bottom',
  },
  {
    id: 'account',
    selector: '[data-demo-step="user-menu"]',
    title: 'Account menu',
    description:
      'Open Help for this guide (including sharing), adjust preferences (auto-approve, expenses), send feedback, or choose Take a tour again anytime.',
    side: 'bottom',
  },
];

export function getDemoStepSelectors(): string[] {
  return DEMO_STEPS.map((step) => step.selector);
}

export function getDemoStepIds(): string[] {
  return DEMO_STEPS.map((step) => step.id);
}
