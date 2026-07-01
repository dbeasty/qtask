import type { Project } from '../types';

interface ProjectComboBoxProps {
  value: string;
  projects: Project[];
  onChange: (name: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ProjectComboBox({
  value,
  projects,
  onChange,
  disabled = false,
  placeholder = 'Select or type a project',
}: ProjectComboBoxProps) {
  const listId = 'project-list-options';
  const normalized = value.trim().toLowerCase();
  const filtered = normalized
    ? projects.filter((project) => project.name.toLowerCase().includes(normalized))
    : projects;

  return (
    <div className="project-combobox">
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
      <datalist id={listId}>
        {filtered.map((project) => (
          <option key={project._id} value={project.name} />
        ))}
      </datalist>
    </div>
  );
}
