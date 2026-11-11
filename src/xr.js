/**
 * WebXR entry: prefers passthrough AR (Quest 3 / Quest Pro), falls back to VR.
 * On a headset the simulated display is drawn into the right eye only, at the same
 * angular size and placement as on the glasses — the most faithful preview available.
 */
export async function initXR(renderer, button, note, hooks) {
  if (!('xr' in navigator)) {
    note.textContent = 'WebXR not available in this browser. Open on a Quest (https) to try it in-headset.';
    return;
  }
  const supports = async (m) => {
    try { return await navigator.xr.isSessionSupported(m); } catch { return false; }
  };
  const ar = await supports('immersive-ar');
  const vr = await supports('immersive-vr');
  if (!ar && !vr) {
    note.textContent = 'WebXR is present but no immersive session type is supported here.';
    return;
  }
  const mode = ar ? 'immersive-ar' : 'immersive-vr';
  button.hidden = false;
  button.textContent = ar ? 'Enter XR (passthrough)' : 'Enter VR';
  note.textContent = ar
    ? 'Passthrough AR: the display appears in your right eye only, like the glasses.'
    : 'VR: the display appears in your right eye only, inside the virtual room.';

  let session = null;
  button.addEventListener('click', async () => {
    if (session) { session.end(); return; }
    try {
      session = await navigator.xr.requestSession(mode, {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
    } catch (err) {
      note.textContent = `Could not start XR session: ${err.message || err}`;
      return;
    }
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    button.textContent = 'Exit XR';
    session.addEventListener('select', () => hooks.onSelect && hooks.onSelect());
    session.addEventListener('end', () => {
      session = null;
      button.textContent = ar ? 'Enter XR (passthrough)' : 'Enter VR';
      hooks.onEnd && hooks.onEnd();
    });
    hooks.onStart && hooks.onStart(mode);
  });
}
