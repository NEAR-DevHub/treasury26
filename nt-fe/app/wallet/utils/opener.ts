/**
 * Post a message to the dApp window that opened this popup. The connector
 * script listens for `trezu:pending` and `trezu:result` messages.
 */
export function sendResultToOpener(data: Record<string, unknown>) {
    if (window.opener) {
        window.opener.postMessage(data, "*");
    }
}
