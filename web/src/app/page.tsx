import { Suspense } from "react";
import { connection } from "next/server";
import { Dashboard } from "@/components/Dashboard";
import { loadDashboardData } from "@/lib/data";

/**
 * Live data boundary.
 *
 * `node:sqlite` reads are synchronous, so under Next 16's `cacheComponents` the
 * call would otherwise be folded into the prerender. The Next docs call this
 * case out explicitly: `await connection()` inside a Suspense boundary forces
 * request-time rendering, which is what we want — re-running `python etl/load.py`
 * is visible on the very next page load with no dev-server restart or rebuild.
 */
async function LiveDashboard() {
  await connection();
  const data = loadDashboardData();
  return <Dashboard data={data} />;
}

function Loading() {
  return (
    <main className="mx-auto max-w-[1500px] px-4 py-10">
      <div className="animate-pulse space-y-3">
        <div className="h-32 rounded-2xl bg-line/70" />
        <div className="h-24 rounded-2xl bg-line/60" />
        <div className="h-96 rounded-2xl bg-line/50" />
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <LiveDashboard />
    </Suspense>
  );
}
