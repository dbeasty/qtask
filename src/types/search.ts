export type SearchEntityType = 'project' | 'task';

export interface SearchHit {
  id: string;
  type: SearchEntityType;
  title: string;
  snippet?: string;
  score: number;
  projectNames?: string[];
  status?: string;
}

export interface SearchResults {
  projects: SearchHit[];
  tasks: SearchHit[];
}
