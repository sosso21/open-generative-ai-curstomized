import { redirect } from 'next/navigation';

// The agent pages link back to /agents (create, edit, delete): the agent list lives in the studio.
export default function AgentsIndex() {
  redirect('/studio/agents');
}
