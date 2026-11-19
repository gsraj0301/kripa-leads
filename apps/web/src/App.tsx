import { useCallback, useEffect, useMemo, useState } from "react";
import {
  estimateDiscoveryCredits,
  type GeocodeCandidate,
  type MeResponse,
  type Run,
  type Settings,
} from "@kripa/shared";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; me: MeResponse["actor"]; settings: Settings }
  | { status: "error"; message: string };

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

function statusClass(status: string): string {
  if (status === "completed") return "bg-emerald-100 text-emerald-800";
  if (status === "failed") return "bg-red-100 text-red-800";
  if (status === "discovering") return "bg-sky-100 text-sky-800";
  if (status === "enriching") return "bg-indigo-100 text-indigo-800";
  if (status === "planned") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [runs, setRuns] = useState<Run[]>([]);
  const [area, setArea] = useState("");
  const [countryCode, setCountryCode] = useState("in");
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [segmentIds, setSegmentIds] = useState<string[]>([]);
  const [includeDelivered, setIncludeDelivered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    const response = await fetch("/api/runs");
    if (!response.ok) return;
    const body = (await response.json()) as { runs: Run[] };
    setRuns(body.runs);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [meResponse, settingsResponse] = await Promise.all([
          fetch("/api/me"),
          fetch("/api/settings"),
          refreshRuns(),
        ]);

        if (meResponse.status === 401 || settingsResponse.status === 401) {
          throw new Error("Sign in through Cloudflare Access to continue.");
        }
        if (!meResponse.ok) throw new Error(`Session request failed (${meResponse.status}).`);
        if (!settingsResponse.ok) {
          throw new Error(`Settings request failed (${settingsResponse.status}).`);
        }

        const me = (await meResponse.json()) as MeResponse;
        const { settings } = (await settingsResponse.json()) as { settings: Settings };
        if (!cancelled) {
          setState({ status: "ready", me: me.actor, settings });
          setCountryCode(settings.discovery.defaultCountryCode ?? "in");
          setSegmentIds((current) =>
            current.length > 0
              ? current
              : settings.segments.filter((segment) => segment.enabled).map((segment) => segment.id),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load the app.",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshRuns]);

  const hasActiveRun = runs.some(
    (run) => run.status === "planned" || run.status === "discovering",
  );

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => void refreshRuns(), 3_000);
    return () => clearInterval(timer);
  }, [hasActiveRun, refreshRuns]);

  const enabledSegments = state.status === "ready" ? state.settings.segments.filter((s) => s.enabled) : [];
  const selectedSegments = enabledSegments.filter((segment) => segmentIds.includes(segment.id));
  const categories = [...new Set(selectedSegments.flatMap((segment) => segment.categories))];
  const estimate =
    state.status === "ready"
      ? estimateDiscoveryCredits(
          categories.length,
          state.settings.discovery.maxResultsPerCategory,
        )
      : null;

  const selectedCandidate = candidates.find((candidate) => candidate.placeId === selectedPlaceId);

  const geocode = async () => {
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ area, countryCode: countryCode || undefined }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as {
        candidates: GeocodeCandidate[];
        creditsUsed: number;
      };
      setCandidates(body.candidates);
      setSelectedPlaceId(body.candidates[0]?.placeId ?? "");
      if (body.candidates.length === 0) setMessage("No matching area found. Try a wider name.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Geocoding failed.");
    } finally {
      setBusy(false);
    }
  };

  const createPlan = async () => {
    if (!selectedCandidate) return;
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaText: area,
          resolvedPlaceId: selectedCandidate.placeId,
          resolvedLabel: selectedCandidate.label,
          segmentIds,
          includePreviouslyDelivered: includeDelivered,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await refreshRuns();
      setMessage("Run planned. Start it when you are ready to spend Geoapify credits.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the run.");
    } finally {
      setBusy(false);
    }
  };

  const startRun = async (runId: string) => {
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/runs/${runId}/start`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
      await refreshRuns();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the run.");
    } finally {
      setBusy(false);
    }
  };

  const toggleSegment = (id: string) => {
    setSegmentIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Kripa Leads</h1>
            <p className="text-sm text-slate-500">Discovery and qualification console</p>
          </div>
          {state.status === "ready" && (
            <div className="text-right text-sm">
              <div className="font-medium text-slate-700">{state.me.email}</div>
              <div className="text-xs uppercase tracking-wide text-slate-400">
                {state.me.mode === "dev" ? "local dev session" : "Cloudflare Access"}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {state.status === "loading" && (
          <p className="text-sm text-slate-500">Loading configuration...</p>
        )}

        {state.status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {state.message}
          </div>
        )}

        {state.status === "ready" && (
          <>
            {state.settings.provisional && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <div className="text-sm font-semibold text-amber-900">
                  Provisional configuration
                </div>
                <p className="mt-1 text-sm text-amber-800">
                  {state.settings.provisionalReason ??
                    "Weights, floor, and retention are pending Kripa's approval."}
                </p>
              </div>
            )}

            {message && (
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
                {message}
              </div>
            )}

            {state.settings.approved && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                Configuration approved.
              </div>
            )}

            <section className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  Config version
                </div>
                <div className="mt-1 text-2xl font-semibold">
                  {state.settings.configVersion}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  Enabled segments
                </div>
                <div className="mt-1 text-2xl font-semibold">{enabledSegments.length}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-slate-400">Daily budget</div>
                <div className="mt-1 text-2xl font-semibold">
                  {state.settings.discovery.dailyCreditBudget}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-700">Plan a run</h2>
              </div>
              <div className="space-y-4 p-4">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-64 flex-1 text-sm">
                    <span className="mb-1 block font-medium text-slate-700">Area</span>
                    <input
                      value={area}
                      onChange={(event) => setArea(event.target.value)}
                      placeholder="Chennai"
                      className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                    />
                  </label>
                  <label className="w-28 text-sm">
                    <span className="mb-1 block font-medium text-slate-700">Country</span>
                    <input
                      value={countryCode}
                      onChange={(event) => setCountryCode(event.target.value.toLowerCase())}
                      maxLength={2}
                      className="w-full rounded border border-slate-300 px-3 py-2 text-sm uppercase outline-none focus:border-slate-500"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void geocode()}
                    disabled={busy || area.trim().length < 2}
                    className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Find area
                  </button>
                </div>

                {candidates.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-slate-400">
                      Resolved candidates
                    </div>
                    {candidates.map((candidate) => (
                      <label
                        key={candidate.placeId}
                        className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 p-2 text-sm"
                      >
                        <input
                          type="radio"
                          name="place"
                          checked={selectedPlaceId === candidate.placeId}
                          onChange={() => setSelectedPlaceId(candidate.placeId)}
                          className="mt-1"
                        />
                        <span>
                          <span className="font-medium">{candidate.label}</span>
                          <span className="ml-2 text-xs text-slate-500">
                            {candidate.resultType ?? "place"}
                            {candidate.confidence !== null
                              ? ` · ${Math.round(candidate.confidence * 100)}%`
                              : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">
                    Segments
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {enabledSegments.map((segment) => (
                      <label key={segment.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={segmentIds.includes(segment.id)}
                          onChange={() => toggleSegment(segment.id)}
                        />
                        {segment.label}
                      </label>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={includeDelivered}
                    onChange={(event) => setIncludeDelivered(event.target.checked)}
                  />
                  Include companies already delivered
                </label>

                {estimate && (
                  <p className="text-sm text-slate-600">
                    Up to <span className="font-semibold">{estimate.total}</span> credits for{" "}
                    {categories.length} categories, {state.settings.discovery.maxResultsPerCategory}{" "}
                    results each. The run aborts before exceeding the daily budget.
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void createPlan()}
                  disabled={busy || !selectedCandidate || segmentIds.length === 0}
                  className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Create plan
                </button>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-700">Runs</h2>
                <button
                  type="button"
                  onClick={() => void refreshRuns()}
                  className="text-xs font-medium text-slate-500 hover:text-slate-800"
                >
                  Refresh
                </button>
              </div>
              {runs.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-500">
                  No runs yet. Resolve an area, choose segments, and create a plan.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {runs.map((run) => (
                    <li key={run.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">{run.areaText}</div>
                          <div className="text-xs text-slate-500">
                            {run.resolvedLabel ?? "unresolved"} ·{" "}
                            {new Date(run.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(run.status)}`}
                          >
                            {run.status}
                          </span>
                          {run.status === "planned" && (
                            <button
                              type="button"
                              onClick={() => void startRun(run.id)}
                              disabled={busy}
                              className="rounded bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                            >
                              Start
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span>raw {run.counts.raw}</span>
                        <span>valid {run.counts.valid}</span>
                        <span>enriched {run.counts.enriched}</span>
                        <span>pages {run.counts.pagesFetched}</span>
                        {run.counts.enrichmentFailures > 0 && (
                          <span className="text-red-600">
                            site failures {run.counts.enrichmentFailures}
                          </span>
                        )}
                        {run.counts.skippedNoWebsite > 0 && (
                          <span>no website {run.counts.skippedNoWebsite}</span>
                        )}
                        <span>delivered dropped {run.counts.droppedDelivered}</span>
                        <span>credits {run.counts.creditsUsed}</span>
                        <span>segments {run.segmentIds.join(", ")}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-700">Segments</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {state.settings.segments.map((segment) => (
                  <li key={segment.id} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div>
                      <div className="text-sm font-medium">{segment.label}</div>
                      <div className="text-xs text-slate-500">{segment.buyer}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {segment.categories.map((category) => (
                          <span
                            key={category}
                            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
                          >
                            {category}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span
                      className={
                        segment.enabled
                          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
                          : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500"
                      }
                    >
                      {segment.enabled ? "enabled" : "disabled"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
