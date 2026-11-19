(function () {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const message = document.getElementById('message');
  const accessibility = document.getElementById('accessibility-step');
  const screenRecording = document.getElementById('screen-recording-step');
  let checkMessage = message.textContent;
  async function refresh() {
    try {
      const status = await invoke('desktop_permission_status');
      if (status.accessibility && status.screenRecording) {
        await invoke('plugin:window|close');
        return;
      }
      accessibility.hidden = status.accessibility;
      screenRecording.hidden = !status.accessibility;
      if (message.textContent === checkMessage) message.textContent = '';
      checkMessage = '';
    } catch (error) {
      checkMessage = 'Could not check permissions: ' + error;
      message.textContent = checkMessage;
    }
    window.setTimeout(refresh, 1000);
  }
  function open(permission) {
    message.textContent = '';
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
  refresh();
})();
