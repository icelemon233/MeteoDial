// Keep in-flight reads for the visible layers across layout changes. Each layer
// may read one time ahead, after its nearer field has arrived.
export function playbackBuffer(read) {
  const entries = new Map();
  let wanted = new Set();
  const key = (layer, time) => layer + '/' + time;

  function retain(keys) {
    wanted = keys;
    for (const [id, entry] of entries) {
      if (wanted.has(id)) continue;
      entry.controller.abort();
      entries.delete(id);
    }
  }
  function field(layer, time) {
    const id = key(layer, time);
    if (entries.has(id)) return entries.get(id);
    const controller = new AbortController();
    const promise = read(layer, time, {controller, requests:new Map()}).then(
      value => ({status:'fulfilled', value}),
      reason => ({status:'rejected', reason})
    );
    const entry = {controller, promise};
    entries.set(id, entry);
    return entry;
  }
  return {
    plan(layers, time, following) {
      retain(new Set(layers.flatMap(layer => [key(layer, time), key(layer, following)])));
      return layers.map(layer => {
        const id = key(layer, time), entry = field(layer, time);
        void entry.promise.then(result => {
          if (result.status === 'fulfilled' && entries.get(id) === entry && wanted.has(key(layer, following)))
            field(layer, following);
        });
        return entry.promise;
      });
    },
    clear() { retain(new Set()); },
  };
}
