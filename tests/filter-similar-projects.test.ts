import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterSimilarProjects } from '../src/utils/filterSimilarProjects.ts';
import { isSimilarName } from '../src/utils/nameSimilarity.ts';

describe('isSimilarName', () => {
  it('matches shared words and substring overlap', () => {
    assert.equal(isSimilarName('Sell Airplane', 'Sell the Motorcycle'), true);
    assert.equal(isSimilarName('Volvo XC90', 'Volvo'), true);
  });

  it('does not match unrelated names', () => {
    assert.equal(isSimilarName('Volvo', 'Boat'), false);
    assert.equal(isSimilarName('Volvo', 'Fix the HVAC'), false);
    assert.equal(isSimilarName('Volvo', 'Sell Smart For Two'), false);
  });

  it('does not match exact names', () => {
    assert.equal(isSimilarName('Volvo', 'Volvo'), false);
  });
});

describe('filterSimilarProjects', () => {
  const projects = [
    { _id: '1', name: 'Boat', parentId: null },
    { _id: '2', name: 'Sell Airplane', parentId: null },
    { _id: '3', name: 'Sell the Motorcycle', parentId: null },
    { _id: '4', name: 'Fix the HVAC', parentId: null },
    { _id: '5', name: 'Sell Smart For Two', parentId: null },
  ];

  it('returns only name-similar root projects', () => {
    const similar = filterSimilarProjects(projects, 'Volvo', { parentId: null, isSubProject: false });
    assert.deepEqual(
      similar.map((project) => project.name),
      []
    );
  });

  it('returns sell-related projects when creating another sell project', () => {
    const similar = filterSimilarProjects(projects, 'Sell Trailer', {
      parentId: null,
      isSubProject: false,
    });
    assert.deepEqual(
      similar.map((project) => project.name).sort(),
      ['Sell Airplane', 'Sell Smart For Two', 'Sell the Motorcycle']
    );
  });
});
