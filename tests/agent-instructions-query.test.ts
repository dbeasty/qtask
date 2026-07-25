import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractCreateProjectName,
  isCreateProjectQuery,
  resolveProjectCreateScope,
} from '../src/utils/createProjectQuery.ts';
import {
  extractCreateTaskTitle,
  isCreateTaskQuery,
} from '../src/utils/createTaskQuery.ts';
import { isCurrentProjectQuery } from '../src/utils/currentProjectQuery.ts';
import { isListProjectTasksQuery } from '../src/utils/listProjectTasksQuery.ts';
import { isListProjectsQuery } from '../src/utils/listProjectsQuery.ts';
import { AGENT_INSTRUCTIONS } from './fixtures/agentInstructions.ts';

const ACTIVE_PROJECT_ID = 'abc123';

describe('agent instruction query matchers', () => {
  for (const instruction of AGENT_INSTRUCTIONS.filter((entry) => entry.route === 'preflight')) {
    it(`${instruction.id} matches the expected preflight query parser`, () => {
      switch (instruction.id) {
        case 'create-project':
        case 'create-subproject':
        case 'create-project-with-subproject-steps':
        case 'create-project-with-tasks-steps':
          assert.equal(isCreateProjectQuery(instruction.example), true);
          assert.ok(extractCreateProjectName(instruction.example));
          if (instruction.id === 'create-subproject') {
            assert.deepEqual(
              resolveProjectCreateScope(instruction.example, ACTIVE_PROJECT_ID),
              { parentId: ACTIVE_PROJECT_ID, isSubProject: true }
            );
          } else {
            assert.deepEqual(
              resolveProjectCreateScope(instruction.example, ACTIVE_PROJECT_ID),
              { parentId: null, isSubProject: false }
            );
          }
          break;
        case 'add-task':
          assert.equal(isCreateTaskQuery(instruction.example), true);
          assert.ok(extractCreateTaskTitle(instruction.example));
          break;
        case 'list-current-project':
          assert.equal(isCurrentProjectQuery(instruction.example), true);
          assert.equal(isListProjectsQuery(instruction.example), false);
          for (const phrase of instruction.alsoAccepts ?? []) {
            assert.equal(isCurrentProjectQuery(phrase), true, phrase);
            assert.equal(isListProjectsQuery(phrase), false, phrase);
          }
          break;
        case 'list-all-projects':
          assert.equal(isListProjectsQuery(instruction.example), true);
          assert.equal(isCurrentProjectQuery(instruction.example), false);
          break;
        case 'list-current-project-tasks':
          assert.equal(isListProjectTasksQuery(instruction.example), true);
          assert.equal(isCurrentProjectQuery(instruction.example), false);
          assert.equal(isListProjectsQuery(instruction.example), false);
          break;
        default:
          throw new Error(`Unhandled preflight instruction: ${instruction.id}`);
      }
    });
  }

  it('list current project does not match list-all-projects', () => {
    assert.equal(isCurrentProjectQuery('list current project'), true);
    assert.equal(isListProjectsQuery('list current project'), false);
  });
});
