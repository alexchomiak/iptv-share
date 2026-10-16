import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { GUIDE_CACHE_LIMIT, guideRequests } from '../../lib/guideWindow.js';

export default function useGuidePrograms(channels, viewport, generation) {
  const cache = useRef(new Map());
  const cacheGeneration = useRef(generation);
  const [state, setState] = useState({ programs: [], loading: false, error: '' });
  const requests = useMemo(() => guideRequests(channels, viewport), [channels, viewport]);
  const requestKey = requests.map(request => request.key).join('|');
  useEffect(() => {
    if (cacheGeneration.current !== generation) {
      cache.current.clear();
      cacheGeneration.current = generation;
    }
    const controller = new AbortController();
    const collect = () => [...new Map(requests.flatMap(request => cache.current.get(request.key) || []).map(program => [program.id, program])).values()];
    setState({ programs: collect(), loading: requests.some(request => !cache.current.has(request.key)), error: '' });
    const work = requests.map(async request => {
      if (cache.current.has(request.key)) {
        const hit = cache.current.get(request.key);
        cache.current.delete(request.key);
        cache.current.set(request.key, hit);
        return;
      }
      const response = await api(`/api/epg?start=${request.start}&end=${request.end}&channelIds=${request.ids.join(',')}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Could not load this part of the guide.');
      const payload = await response.json();
      if (controller.signal.aborted) return;
      cache.current.set(request.key, payload.programs);
      while (cache.current.size > GUIDE_CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value);
      setState({ programs: collect(), loading: true, error: '' });
    });
    Promise.allSettled(work).then(results => {
      if (controller.signal.aborted) return;
      setState({ programs: collect(), loading: false, error: results.some(result => result.status === 'rejected') ? 'Could not load this part of the guide. Scroll to retry, or refresh.' : '' });
    });
    return () => controller.abort();
  }, [requestKey, generation]);
  return state;
}
