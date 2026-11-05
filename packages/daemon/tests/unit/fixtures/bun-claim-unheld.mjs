const postMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (data, ...args) {
  const message = data?.hold === true ? { ...data, hold: false } : data;
  return postMessage.call(this, message, ...args);
};
