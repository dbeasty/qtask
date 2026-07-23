import { useState } from 'react';
import type { ExpenseTreeNode } from '../types';
import { formatMoney } from '../utils/costRollup';

interface ExpenseTreeProps {
  nodes: ExpenseTreeNode[];
  showHours?: boolean;
  onNavigate?: (taskId: string, path: string[]) => void;
  defaultExpandedDepth?: number;
  depth?: number;
}

function ExpenseTreeRow({
  node,
  showHours,
  onNavigate,
  defaultExpandedDepth,
  depth,
}: {
  node: ExpenseTreeNode;
  showHours?: boolean;
  onNavigate?: (taskId: string, path: string[]) => void;
  defaultExpandedDepth: number;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);
  const hasChildren = node.children.length > 0;
  const hoursTotal = node.rollup.hoursSpent + node.rollup.hoursRemaining;

  return (
    <div className={`expense-tree-node expense-tree-depth-${depth}`}>
      <div className="expense-tree-row">
        {hasChildren ? (
          <button
            type="button"
            className={`expense-tree-chevron${expanded ? ' expanded' : ''}`}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded((current) => !current)}
          >
            ›
          </button>
        ) : (
          <span className="expense-tree-chevron-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="expense-tree-title"
          onClick={() => onNavigate?.(node.taskId, node.path)}
          disabled={!onNavigate}
        >
          {node.title}
        </button>
        {onNavigate ? (
          <button
            type="button"
            className="expense-tree-meta"
            onClick={() => onNavigate(node.taskId, node.path)}
          >
            {showHours && hoursTotal > 0 && `${hoursTotal.toFixed(2)}h · `}
            {formatMoney(node.rollup.totalCost)}
          </button>
        ) : (
          <span className="expense-tree-meta">
            {showHours && hoursTotal > 0 && `${hoursTotal.toFixed(2)}h · `}
            {formatMoney(node.rollup.totalCost)}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <div className="expense-tree-children">
          {node.children.map((child) => (
            <ExpenseTreeRow
              key={`${child.taskId}-${child.path.join('/')}`}
              node={child}
              showHours={showHours}
              onNavigate={onNavigate}
              defaultExpandedDepth={defaultExpandedDepth}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ExpenseTree({
  nodes,
  showHours = true,
  onNavigate,
  defaultExpandedDepth = 1,
  depth = 0,
}: ExpenseTreeProps) {
  if (nodes.length === 0) return null;

  return (
    <div className="expense-tree">
      {nodes.map((node) => (
        <ExpenseTreeRow
          key={`${node.taskId}-${node.path.join('/') || 'root'}`}
          node={node}
          showHours={showHours}
          onNavigate={onNavigate}
          defaultExpandedDepth={defaultExpandedDepth}
          depth={depth}
        />
      ))}
    </div>
  );
}
