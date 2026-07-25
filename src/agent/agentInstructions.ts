export type AgentInstruction = {
  id: string;
  goal: string;
  /** Concrete phrase used in tests and USER_GUIDE. */
  example: string;
  route: 'preflight' | 'llm';
  /** Primary tool invoked (or first in a chain). */
  expectedTool: string;
  /** Alternate phrasing validated by query matcher tests only. */
  alsoAccepts?: string[];
  /** Multi-step compound instructions (each step is a separate user message). */
  steps?: string[];
};

export const AGENT_INSTRUCTIONS: AgentInstruction[] = [
  {
    id: 'create-project',
    goal: 'Create a project',
    example: 'create project Kitchen Reno',
    route: 'preflight',
    expectedTool: 'create_project',
  },
  {
    id: 'create-subproject',
    goal: 'Create a sub-project',
    example: 'create sub-project Electrical',
    route: 'preflight',
    expectedTool: 'create_project',
  },
  {
    id: 'create-project-with-subproject-single',
    goal: 'Create a project with sub-project (one message)',
    example: 'Create project Boat and sub-project Engine work',
    route: 'llm',
    expectedTool: 'create_project',
  },
  {
    id: 'create-project-with-subproject-steps',
    goal: 'Create a project with sub-project (step by step)',
    example: 'create project Boat',
    route: 'preflight',
    expectedTool: 'create_project',
    steps: ['create project Boat', 'create sub-project Engine work'],
  },
  {
    id: 'create-project-with-tasks-single',
    goal: 'Create a project with tasks (one message)',
    example: 'Create project Garden and add tasks: Plan layout, Buy soil, Plant herbs',
    route: 'llm',
    expectedTool: 'create_project',
  },
  {
    id: 'create-project-with-tasks-steps',
    goal: 'Create a project with tasks (step by step)',
    example: 'create project Garden',
    route: 'preflight',
    expectedTool: 'create_project',
    steps: [
      'create project Garden',
      'Add tasks: Plan layout, Buy soil, Plant herbs',
    ],
  },
  {
    id: 'add-task',
    goal: 'Add a new task',
    example: 'add a task to Schedule inspection',
    route: 'preflight',
    expectedTool: 'create_task',
  },
  {
    id: 'add-task-with-similar-existing',
    goal: 'Add a task when similar tasks already exist in the project',
    example: 'add task vacuum the car',
    route: 'preflight',
    expectedTool: 'create_task',
    steps: ['get me tasks for current project', 'add task vacuum the car'],
  },
  {
    id: 'modify-task',
    goal: 'Modify a task',
    example: 'Mark Schedule inspection as done',
    route: 'llm',
    expectedTool: 'update_task',
  },
  {
    id: 'list-current-project',
    goal: 'List the current project',
    example: 'show me the current project',
    route: 'preflight',
    expectedTool: 'get_project',
    alsoAccepts: ['list current project'],
  },
  {
    id: 'list-all-projects',
    goal: 'Get all projects',
    example: 'get me all the projects',
    route: 'preflight',
    expectedTool: 'list_projects',
  },
  {
    id: 'list-current-project-tasks',
    goal: 'Get tasks for the current project',
    example: 'get me tasks for current project',
    route: 'preflight',
    expectedTool: 'find_tasks',
  },
];

export function instructionById(id: string): AgentInstruction {
  const instruction = AGENT_INSTRUCTIONS.find((entry) => entry.id === id);
  if (!instruction) {
    throw new Error(`Unknown agent instruction: ${id}`);
  }
  return instruction;
}
