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

/* Mirrors the real layout (header, five stats, tab row, scope bar, table) so
   the page does not jump when the data arrives. */
function Loading() {
  return (
    <main
      className="mx-auto max-w-[1560px] px-3 py-5 sm:px-5 sm:py-7"
      aria-busy="true"
      aria-label="در حال بارگذاری"
    >
      <div className="animate-pulse space-y-4">
        <div className="rounded-2xl bg-line/60 px-4 py-4 sm:px-5">
          <div className="h-6 w-72 rounded bg-line/80" />
          <div className="mt-2 h-3 w-full max-w-3xl rounded bg-line/70" />
          <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-16 rounded-xl bg-line/80" />
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-96 rounded-xl bg-line/70" />
        </div>
        <div className="h-12 rounded-2xl bg-line/60" />
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
