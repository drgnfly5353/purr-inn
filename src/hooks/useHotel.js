import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { residentEventsBetween, residentsAt } from "../game/residents";
import { applyCare } from "../game/care";

const KEEP_EVENTS_MS = 120000;
// A short pause between repeats of the same action on the same cat.
const COOLDOWN_MS = { feed: 3500, play: 3000, brush: 3500, nap: 4000, pet: 1400, treat: 2500 };

export const now = () => Date.now();

/**
 * Everything the hotel screen needs: who is here, what is happening, and
 * actions for looking after your cat (and saying hello to everyone else's).
 *
 * This version runs on one device: the courtyard is your cat plus the
 * resident cats, who are simulated on a fixed schedule (game/residents.js).
 *
 * A guest is { id, cat, stats, joinedAt }: an anonymous id plus a cat. An
 * event is { id, type, at, by, byCat, catId, catName }: who acted (their id
 * and their cat's name, which is how they are shown) and which cat it was for.
 * Feedback happens in the courtyard itself, so there are no notifications.
 */
export function useHotel({ profile, withResidents = true, onStatsChange }) {
  const me = profile;
  const [stats, setStats] = useState(profile.stats);
  // The latest stats without waiting for a render, for event handlers.
  // Only changeStats() changes them, and it updates both.
  const statsRef = useRef(stats);
  const [residents, setResidents] = useState(() => (withResidents ? residentsAt(now()) : []));
  const [events, setEvents] = useState([]);
  const [feed, setFeed] = useState([]);
  const seen = useRef(new Set());
  const cooldowns = useRef({});
  // id -> { cat, look } for everyone in the hotel, for naming events.
  const catsRef = useRef(new Map());

  const changeStats = useCallback(
    (next) => {
      setStats(next);
      statsRef.current = next;
      onStatsChange?.(next);
    },
    [onStatsChange],
  );

  // Every event, from any source (your actions, the residents), goes through
  // here exactly once: duplicates are dropped by id.
  const ingest = useCallback((list) => {
    const fresh = list.filter((ev) => ev && !seen.current.has(ev.id));
    if (!fresh.length) return;
    for (const ev of fresh) seen.current.add(ev.id);
    const cutoff = now() - KEEP_EVENTS_MS;
    setEvents((prev) => [...prev.filter((e) => e.at > cutoff), ...fresh].sort((a, b) => a.at - b.at));
    setFeed((prev) => [...fresh.map((ev) => ({ ...ev, kind: ev.type })), ...prev].sort((a, b) => b.at - a.at).slice(0, 40));
  }, []);

  // The doors open and your cat arrives, once.
  useEffect(() => {
    if (!me.arriving) return;
    ingest([{ id: `arrive:${me.id}:${me.joinedAt}`, type: "arrive", at: me.joinedAt, by: me.id, byCat: me.cat.name, catId: me.id, catName: me.cat.name }]);
  }, [me, ingest]);

  // Residents come and go and do things on a fixed schedule.
  useEffect(() => {
    if (!withResidents) return undefined;
    let last = now();
    const ids = () => [me.id, ...catsRef.current.keys()];
    // A little history so the diary isn't empty; residents only had their own
    // cats to fuss over before you arrived.
    ingest(residentEventsBetween(last - 90000, last, []));
    const timer = setInterval(() => {
      const t = now();
      setResidents((prev) => {
        const next = residentsAt(t);
        return next.map((r) => r.id).join() === prev.map((r) => r.id).join() ? prev : next;
      });
      ingest(residentEventsBetween(last, t, ids()));
      last = t;
    }, 1000);
    return () => clearInterval(timer);
  }, [withResidents, ingest, me.id]);

  // You first, then the residents.
  const guests = useMemo(() => {
    const self = { id: me.id, cat: me.cat, stats, joinedAt: me.joinedAt, online: true, isMe: true };
    return [self, ...residents];
  }, [me, stats, residents]);

  // Keep the cat lookup current.
  useEffect(() => {
    catsRef.current = new Map(guests.map((g) => [g.id, { cat: g.cat?.name, look: g.cat?.look }]));
  }, [guests]);

  // Do something to a cat (yours by default). Returns { ok, event } or
  // { ok: false, reason } so the screen can react without any text.
  const act = useCallback(
    (type, { catId = me.id, x, y } = {}) => {
      const t = now();
      const key = `${type}:${catId}`;
      if ((cooldowns.current[key] ?? 0) > t) return { ok: false, reason: "cooldown" };
      if (catId === me.id) {
        const result = applyCare(statsRef.current, type, t);
        if (!result.ok) return result;
        changeStats(result.stats);
      }
      cooldowns.current[key] = t + (COOLDOWN_MS[type] ?? 2000);
      const ev = {
        id: `${me.id}:${t}:${type}`,
        type,
        at: t,
        by: me.id,
        byCat: me.cat.name,
        catId,
        catName: catsRef.current.get(catId)?.cat ?? me.cat.name,
        // Where a toy was tossed.
        ...(x != null ? { x: Math.round(x), y: Math.round(y) } : {}),
      };
      ingest([ev]);
      return { ok: true, event: ev };
    },
    [me, changeStats, ingest],
  );

  // Friendly moments between cats (boops, grooming...) found by the
  // simulation; they only go to the diary.
  const addMoments = useCallback((moments) => {
    const fresh = moments.filter((m) => !seen.current.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) seen.current.add(m.id);
    setFeed((prev) => [...fresh.map((m) => ({ ...m, kind: "social" })), ...prev].sort((a, b) => b.at - a.at).slice(0, 40));
  }, []);

  return { guests, stats, events, feed, act, addMoments };
}
