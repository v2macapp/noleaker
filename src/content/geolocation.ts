/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SpoofConfig } from '../shared/spoof-config';
import { createNative } from './native';

const MIN_DELAY = 150;
const MAX_DELAY = 550;
const MIN_ACCURACY = 20;
const MAX_ACCURACY = 100;
const WATCH_INTERVAL = 15_000;
const METERS_PER_DEGREE = 111_320;

export interface GeolocationOptions {
  /** Random source in [0, 1). Injectable for tests. */
  random?: () => number;
  pending?: boolean;
}

/**
 * Geolocation in the exit country. While on, the page never gets a real position and never
 * gets PERMISSION_DENIED: `permissions.query` says "granted" and callbacks succeed.
 */
export function installGeolocation(
  g: any,
  { random = Math.random, pending = false }: GeolocationOptions = {},
): { setConfig(config: SpoofConfig | null): void } {
  const { patch, define, method } = createNative(g);
  let denied = false;
  // B6: calls made before the config arrives wait for it, then run as if made just after it.
  // shortcut: a waiting call ignores its `timeout` option; add a timer if a site relies on it.
  let waiting: (() => void)[] | null = pending ? [] : null;
  let point: { latitude: number; longitude: number } | null = null;
  const nativeWatches = new Map<number, () => void>();
  let stopSyntheticWatches = () => {};

  const between = (min: number, max: number) => min + random() * (max - min);

  /** A GeolocationPosition look-alike: right prototype, values inside the accuracy radius. */
  function position(): any {
    const accuracy = Math.round(between(MIN_ACCURACY, MAX_ACCURACY) * 10) / 10;
    const jitter = (meters: number) => ((random() - 0.5) * 2 * meters) / METERS_PER_DEGREE;
    const latitude = point!.latitude + jitter(accuracy);
    const longitude =
      point!.longitude +
      jitter(accuracy) / Math.max(0.2, Math.cos((point!.latitude * Math.PI) / 180));

    const coords = Object.create(g.GeolocationCoordinates?.prototype ?? Object.prototype);
    const values = {
      latitude,
      longitude,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    };
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(coords, key, { value, enumerable: true });
    }
    define(
      coords,
      'toJSON',
      method('toJSON', 0, () => ({ ...values })),
    );

    const pos = Object.create(g.GeolocationPosition?.prototype ?? Object.prototype);
    Object.defineProperty(pos, 'coords', { value: coords, enumerable: true });
    Object.defineProperty(pos, 'timestamp', { value: Date.now(), enumerable: true });
    define(
      pos,
      'toJSON',
      method('toJSON', 0, () => ({ coords: { ...values }, timestamp: pos.timestamp })),
    );
    return pos;
  }

  const requireCallback = (fn: unknown, name: string) => {
    if (typeof fn !== 'function') {
      throw new g.TypeError(
        `Failed to execute '${name}' on 'Geolocation': The callback provided as parameter 1 is not a function.`,
      );
    }
  };

  const proto: any = g.Geolocation?.prototype;
  if (proto) {
    const watches = new Map<number, ReturnType<typeof setTimeout>>();
    // Negative IDs cannot collide with native browser watch IDs.
    let nextWatchId = -1;
    const nativeClearWatch = proto.clearWatch;
    stopSyntheticWatches = () => {
      for (const timer of watches.values()) g.clearTimeout(timer);
      watches.clear();
    };

    patch(
      proto,
      'getCurrentPosition',
      (orig) =>
        function (this: any, success: unknown, ...rest: unknown[]) {
          if (waiting) {
            requireCallback(success, 'getCurrentPosition');
            waiting.push(() => proto.getCurrentPosition.call(this, success, ...rest));
            return;
          }
          if (denied) {
            requireCallback(success, 'geolocation');
            const error = rest[0];
            g.setTimeout(() => {
              if (typeof error === 'function')
                error({
                  code: 1,
                  message: 'Location is withheld until protection is ready.',
                  PERMISSION_DENIED: 1,
                  POSITION_UNAVAILABLE: 2,
                  TIMEOUT: 3,
                });
            }, 0);
            return;
          }
          if (!point) {
            if (typeof success !== 'function') return orig.call(this, success, ...rest);
            return orig.call(
              this,
              (nativePosition: any) => {
                if (denied) return;
                success(point ? position() : nativePosition);
              },
              ...rest,
            );
          }
          requireCallback(success, 'getCurrentPosition');
          g.setTimeout(
            () => {
              if (point) (success as any)(position());
            },
            between(MIN_DELAY, MAX_DELAY),
          );
        },
    );
    patch(
      proto,
      'watchPosition',
      (orig) =>
        function (this: any, success: unknown, ...rest: unknown[]) {
          if (waiting) {
            requireCallback(success, 'watchPosition');
            const id = nextWatchId--;
            let cleared = false;
            nativeWatches.set(id, () => void (cleared = true));
            waiting.push(() => {
              nativeWatches.delete(id);
              if (cleared) return;
              const real = proto.watchPosition.call(this, success, ...rest);
              nativeWatches.set(id, () => proto.clearWatch.call(this, real));
            });
            return id;
          }
          if (denied) {
            requireCallback(success, 'geolocation');
            const error = rest[0];
            g.setTimeout(() => {
              if (typeof error === 'function')
                error({
                  code: 1,
                  message: 'Location is withheld until protection is ready.',
                  PERMISSION_DENIED: 1,
                  POSITION_UNAVAILABLE: 2,
                  TIMEOUT: 3,
                });
            }, 0);
            return 0;
          }
          if (!point) {
            if (typeof success !== 'function') return orig.call(this, success, ...rest);
            let active = true;
            const id = orig.call(
              this,
              (nativePosition: any) => {
                if (!active || denied) return;
                success(point ? position() : nativePosition);
              },
              ...rest,
            );
            nativeWatches.set(id, () => {
              active = false;
              nativeClearWatch.call(this, id);
            });
            return id;
          }
          requireCallback(success, 'watchPosition');
          const id = nextWatchId--;
          const tick = () => {
            if (!point) return watches.delete(id); // shield turned off: stop quietly
            (success as any)(position());
            watches.set(id, g.setTimeout(tick, WATCH_INTERVAL + between(0, 5000)));
          };
          watches.set(id, g.setTimeout(tick, between(MIN_DELAY, MAX_DELAY)));
          return id;
        },
    );
    patch(
      proto,
      'clearWatch',
      (orig) =>
        function (this: any, id: unknown) {
          const timer = watches.get(id as number);
          if (timer === undefined) {
            const cancel = nativeWatches.get(id as number);
            nativeWatches.delete(id as number);
            if (cancel) return cancel();
            return orig.call(this, id);
          }
          g.clearTimeout(timer);
          watches.delete(id as number);
        },
    );
  }

  const permissionsProto: any = g.Permissions?.prototype;
  if (permissionsProto?.query) {
    patch(
      permissionsProto,
      'query',
      (orig) =>
        function (this: any, descriptor: any) {
          if (waiting && descriptor?.name === 'geolocation')
            return new g.Promise((resolve: (v: unknown) => void) =>
              waiting!.push(() => resolve(permissionsProto.query.call(this, descriptor))),
            );
          const result = orig.call(this, descriptor);
          if ((!point && !denied) || descriptor?.name !== 'geolocation') return result;
          return result.then((status: any) => {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(status), 'state');
            const getter = method('get state', 0, () =>
              denied ? 'denied' : point ? 'granted' : desc?.get?.call(status),
            );
            Object.defineProperty(status, 'state', {
              get: getter,
              configurable: true,
              enumerable: true,
            });
            return status;
          });
        },
    );
  }

  return {
    setConfig(config) {
      denied =
        !!config?.strict && (!config.active || !config.coordinates || !config.shields.geolocation);
      const c = config?.active && config.shields.geolocation ? config.coordinates : null;
      point = c ?? null;
      if (denied || point) {
        for (const cancel of nativeWatches.values()) cancel();
        nativeWatches.clear();
      }
      if (!point) stopSyntheticWatches();
      const queued = waiting ?? [];
      waiting = null;
      for (const call of queued) call();
    },
  };
}
