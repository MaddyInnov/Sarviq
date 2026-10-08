// SPDX-License-Identifier: Apache-2.0
import RunDetail from './run-detail';

export async function generateStaticParams(): Promise<Array<{ runId: string }>> {
  // Static export: no run ids are known at build time. Next requires at
  // least one param for `output: 'export'`, so we prerender a placeholder
  // that is never linked. Real run ids render client-side via in-app
  // navigation (clicking a run in the list); the API's SPA fallback serves
  // /index.html for direct deep links.
  return [{ runId: '__placeholder__' }];
}

export default function RunDetailPage({ params }: { params: { runId: string } }) {
  return <RunDetail runId={params.runId} />;
}
