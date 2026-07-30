/**
 * View registry (WP-U5): the ONLY place that maps a route id to a view.
 * NEXT WAVE: swap a view's internals in its own file; this registry and the
 * shell stay untouched. Every component must satisfy ComponentType<ViewProps>.
 */
import type { ComponentType } from 'react';
import type { ViewId } from '../router';
import type { ViewProps } from './types';
import { LiveView } from './LiveView';
import { SessionsView } from './SessionsView';
import { DagView } from './DagView';
import { CostView } from './CostView';

export interface ViewDefinition {
  readonly id: ViewId;
  /** Short label for the sidebar nav. */
  readonly navLabel: string;
  /** Heading rendered above the mounted view. */
  readonly title: string;
  readonly Component: ComponentType<ViewProps>;
}

export const VIEWS: Readonly<Record<ViewId, ViewDefinition>> = {
  live: { id: 'live', navLabel: 'Live', title: 'Live status', Component: LiveView },
  sessions: {
    id: 'sessions',
    navLabel: 'Sessions',
    title: 'Session subagent tree',
    Component: SessionsView,
  },
  dag: { id: 'dag', navLabel: 'DAG', title: 'Global orchestration DAG', Component: DagView },
  cost: { id: 'cost', navLabel: 'Cost', title: 'Cost and savings', Component: CostView },
};
