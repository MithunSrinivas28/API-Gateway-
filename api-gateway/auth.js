const VALID_CLIENTS = {
  'gateway-client': 'supersecret123'
};

function validateClient(clientId, clientSecret) {
  return VALID_CLIENTS[clientId] && VALID_CLIENTS[clientId] === clientSecret;
}

module.exports = { validateClient };