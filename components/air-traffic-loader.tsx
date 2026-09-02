'use client';

import { useEffect, useState } from 'react';

type AirTrafficComponent = typeof import('./air-traffic-app').AirTrafficApp;

function LoadingScreen({ failed = false }: { failed?: boolean }) {
  return (
    <main
      className="relative grid h-dvh w-full place-items-center overflow-hidden bg-[#02070c] text-slate-100"
      aria-busy={!failed}
      aria-live="polite"
    >
      <div className="telemetry-grid pointer-events-none absolute inset-0 opacity-[0.12]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_44%,rgba(34,211,238,.11),transparent_34%,rgba(2,7,12,.92)_76%)]" />

      <section className="relative w-[min(88vw,380px)] border border-cyan-200/15 bg-[#061019]/88 p-6 shadow-[0_0_80px_rgba(34,211,238,.08)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-9 place-items-center border border-cyan-300/35 bg-cyan-300/[0.08]">
            <span className="size-3 rounded-full border border-cyan-200 shadow-[0_0_16px_rgba(103,232,249,.75)]" />
          </div>
          <div>
            <p className="font-semibold tracking-[0.16em] text-white">SKYTRACE</p>
            <p className="font-mono text-[9px] tracking-[0.14em] text-slate-500">GLOBAL AIRSPACE / 3D OPERATIONS</p>
          </div>
        </div>

        <div className="flex items-center justify-between font-mono text-[9px] tracking-[0.16em]">
          <span className={failed ? 'text-amber-200' : 'text-cyan-200'}>
            {failed ? '3D ENGINE UNAVAILABLE' : 'INITIALIZING 3D ENGINE'}
          </span>
          {!failed && <span className="animate-pulse text-cyan-300">LINKING</span>}
        </div>
        <div className="mt-3 h-px overflow-hidden bg-white/10">
          {!failed && <div className="h-full w-2/3 animate-pulse bg-cyan-300" />}
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          {failed
            ? 'The visualizer could not start. Refresh the page to try again.'
            : 'Preparing the globe while live aircraft data connects in the background.'}
        </p>
      </section>
    </main>
  );
}

export function AirTrafficLoader() {
  const [App, setApp] = useState<AirTrafficComponent | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Let the lightweight server-rendered shell paint before downloading and
    // evaluating Three.js. This removes the blank page on cold or slower loads.
    const frame = window.requestAnimationFrame(() => {
      void import('./air-traffic-app')
        .then((module) => {
          if (!cancelled) setApp(() => module.AirTrafficApp);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return App ? <App /> : <LoadingScreen failed={failed} />;
}
