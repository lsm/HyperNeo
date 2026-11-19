(function () {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const message = document.getElementById('message');
  async function refresh() {
    try {
      const status = await invoke('desktop_permission_status');
      document.getElementById('accessibility-status').textContent = status.accessibility
        ? 'Enabled'
        : 'Not enabled';
      document.getElementById('screen-recording-status').textContent = status.screenRecording
        ? 'Enabled'
        : 'Not enabled in this app session';
      document.getElementById('restart-note').textContent = status.screenRecording
        ? ''
        : 'Quit and reopen to finish after enabling Screen Recording in System Settings.';
      message.textContent =
        status.accessibility && status.screenRecording
          ? 'All permissions are enabled. You can close this window.'
          : '';
    } catch (error) {
      message.textContent = 'Could not check permissions: ' + error;
    }
  }
  function open(permission) {
    invoke('open_desktop_permission_settings', { permission }).catch(function (error) {
      message.textContent = 'Could not open System Settings: ' + error;
    });
  }
  document.getElementById('open-accessibility').addEventListener('click', function () {
    open('accessibility');
  });
  document.getElementById('open-screen-recording').addEventListener('click', function () {
    open('screenRecording');
  });
  document.getElementById('check-again').addEventListener('click', refresh);
  window.addEventListener('focus', refresh);
  refresh();
})();
