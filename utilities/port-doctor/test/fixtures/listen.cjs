// A throwaway process for the tests to find and end: listens on a random loopback port, prints it, waits.
const server = require('node:net').createServer()
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
setInterval(() => {}, 1000)
