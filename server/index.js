const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const deviceTable = {}; // { deviceName: [layerNumbers] }
const groupToDeviceTable = {}; // { groupIdx: [deviceNames] }
const layersToGroupTable = {}; // { layerNum: groupIdx }
const deviceSockets = {}; // { deviceName: socket.id }
const TOTAL_LAYERS = 12;
const GROUP_SIZE = 4; // 3 groups of 4 layers each
let sickoModeActive = false;

function resetGroups() {
  for (let i = 0; i < 3; i++) groupToDeviceTable[i] = [];
  for (let i = 1; i <= TOTAL_LAYERS; i++) layersToGroupTable[i] = Math.floor((i - 1) / GROUP_SIZE);
}

function redistributeLayers() {
  const deviceNames = Object.keys(deviceTable);
  if (deviceNames.length === 0) return;

  resetGroups();

  if (deviceNames.length < 3) {
    let layers = Array.from({ length: TOTAL_LAYERS }, (_, i) => i + 1);
    const chunkSize = Math.ceil(TOTAL_LAYERS / deviceNames.length);
    deviceNames.forEach((name, idx) => {
      const assignedLayers = layers.slice(idx * chunkSize, (idx + 1) * chunkSize);
      deviceTable[name] = assignedLayers;

      // Update groupToDeviceTable for each group this device covers
      const groupsCovered = new Set();
      assignedLayers.forEach(layer => {
        const groupIdx = layersToGroupTable[layer];
        groupsCovered.add(groupIdx);
      });
      groupsCovered.forEach(groupIdx => {
        if (!groupToDeviceTable[groupIdx].includes(name)) {
          groupToDeviceTable[groupIdx].push(name);
        }
      });
    });
  } else {
    deviceNames.forEach(name => {
      let minGroup = 0;
      let minCount = groupToDeviceTable[0].length;
      for (let i = 1; i < 3; i++) {
        if (groupToDeviceTable[i].length < minCount) {
          minGroup = i;
          minCount = groupToDeviceTable[i].length;
        }
      }
      groupToDeviceTable[minGroup].push(name);
      const groupLayers = [];
      for (let l = 1; l <= TOTAL_LAYERS; l++) {
        if (layersToGroupTable[l] === minGroup) groupLayers.push(l);
      }
      deviceTable[name] = groupLayers;
    });
  }

  // Push updated layers to all connected devices
  Object.keys(deviceTable).forEach(deviceName => {
    const socketId = deviceSockets[deviceName];
    if (socketId) {
      io.to(socketId).emit('updateLayers', { layers: deviceTable[deviceName] });
    }
  });

  console.log('deviceTable:', deviceTable);
}

app.post('/joinNetwork', (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) return res.status(400).send('Device name required');
  if (!deviceTable[deviceName]) {
    deviceTable[deviceName] = [];
    redistributeLayers();
    console.log(`Device joined: ${deviceName}`);
  }
  res.sendStatus(200);
});

app.post('/disconnect', (req, res) => {
  const { deviceName } = req.body;
  if (deviceTable[deviceName]) {
    const layersToCheck = deviceTable[deviceName];
    let needsRedistribution = false;

    // For each layer this device hosts, check if any other device also hosts it
    for (const layer of layersToCheck) {
      let covered = false;
      for (const otherDevice in deviceTable) {
        if (otherDevice !== deviceName && deviceTable[otherDevice].includes(layer)) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        needsRedistribution = true;
        break;
      }
    }

    delete deviceTable[deviceName];
    Object.values(groupToDeviceTable).forEach(arr => {
      const idx = arr.indexOf(deviceName);
      if (idx !== -1) arr.splice(idx, 1);
    });

    if (needsRedistribution) {
      redistributeLayers();
      console.log(`Device disconnected: ${deviceName} (redistributed layers)`);
    } else {
      console.log(`Device disconnected: ${deviceName} (no redistribution needed)`);
    }
  }
  res.sendStatus(200);
});

app.post('/runComputation', (req, res) => {
  const { deviceName } = req.body;
  const layers = deviceTable[deviceName] || [];
  res.json({ layers });
});

app.get('/devices', (req, res) => {
  res.json(Object.keys(deviceTable));
});

let relayState = null;

// --- SICKO MODE: Only start a new computation after the previous one finishes ---
function startSickoComputation() {
  if (!sickoModeActive) return;
  const deviceNames = Object.keys(deviceTable);
  if (deviceNames.length === 0) return;
  const randomDevice = deviceNames[Math.floor(Math.random() * deviceNames.length)];
  io.emit('clearRelay');
  if (deviceSockets[randomDevice]) {
    io.to(deviceSockets[randomDevice]).emit('relayStarted');
  }
  relayState = {
    originDevice: randomDevice,
    currentGroup: 0,
    groupsOrder: [0, 1, 2],
  };
  const groupDevices = groupToDeviceTable[0] || [];
  if (deviceNames.length > 3 && groupDevices.length > 1) {
    const idx = Math.floor(Math.random() * groupDevices.length);
    const chosen = groupDevices[idx];
    if (deviceSockets[chosen]) {
      io.to(deviceSockets[chosen]).emit('relayMessage', {
        message: 'hello world 0',
        group: 0,
      });
    }
  } else {
    groupDevices.forEach(dName => {
      if (deviceSockets[dName]) {
        io.to(deviceSockets[dName]).emit('relayMessage', {
          message: 'hello world 0',
          group: 0,
        });
      }
    });
  }
}

io.on('connection', (socket) => {
  socket.on('register', (deviceName) => {
    deviceSockets[deviceName] = socket.id;
    // Send current layers on register
    if (deviceTable[deviceName]) {
      socket.emit('updateLayers', { layers: deviceTable[deviceName] });
    }
  });

  socket.on('disconnect', () => {
    for (const [name, id] of Object.entries(deviceSockets)) {
      if (id === socket.id) {
        delete deviceSockets[name];
        break;
      }
    }
  });

  socket.on('enableSickoMode', () => {
    if (!sickoModeActive) {
      sickoModeActive = true;
      io.emit('sickoModeState', { enabled: true });
      startSickoComputation();
    }
  });

  socket.on('disableSickoMode', () => {
    if (sickoModeActive) {
      sickoModeActive = false;
      io.emit('sickoModeState', { enabled: false });
    }
  });

  // On new connection, send current state
  socket.emit('sickoModeState', { enabled: sickoModeActive });

  socket.on('startRelay', (deviceName) => {
    // Clear relay lines for all clients
    io.emit('clearRelay');
    // Notify initiator to print "hello world started"
    if (deviceSockets[deviceName]) {
      io.to(deviceSockets[deviceName]).emit('relayStarted');
    }
    relayState = {
      originDevice: deviceName,
      currentGroup: 0,
      groupsOrder: [0, 1, 2],
    };

    // Routing logic for group 0
    const groupDevices = groupToDeviceTable[0] || [];
    if (Object.keys(deviceTable).length > 3 && groupDevices.length > 1) {
      // More than 3 users: pick one at random
      const idx = Math.floor(Math.random() * groupDevices.length);
      const chosen = groupDevices[idx];
      if (deviceSockets[chosen]) {
        io.to(deviceSockets[chosen]).emit('relayMessage', {
          message: 'hello world 0',
          group: 0,
        });
      }
    } else {
      // 3 or fewer users: broadcast to all hosting devices
      groupDevices.forEach(dName => {
        if (deviceSockets[dName]) {
          io.to(deviceSockets[dName]).emit('relayMessage', {
            message: 'hello world 0',
            group: 0,
          });
        }
      });
    }
  });

  socket.on('relayDone', ({ deviceName, group }) => {
    if (!relayState || group !== relayState.currentGroup) return;
    relayState.currentGroup += 1;
    if (relayState.currentGroup > 2) {
      const originSocket = deviceSockets[relayState.originDevice];
      if (originSocket) {
        io.to(originSocket).emit('relayFinished', { message: 'hello world finished' });
      }
      relayState = null;
      // Only start a new computation if sicko mode is still enabled
      if (sickoModeActive) {
        setTimeout(() => {
          startSickoComputation();
        }, 1000); // 1 second pause between computations
      }
    } else {
      const nextGroup = relayState.currentGroup;
      const groupDevices = groupToDeviceTable[nextGroup] || [];
      if (Object.keys(deviceTable).length > 3 && groupDevices.length > 1) {
        // More than 3 users: pick one at random
        const idx = Math.floor(Math.random() * groupDevices.length);
        const chosen = groupDevices[idx];
        if (deviceSockets[chosen]) {
          io.to(deviceSockets[chosen]).emit('relayMessage', {
            message: `hello world ${nextGroup}`,
            group: nextGroup,
          });
        }
      } else {
        // 3 or fewer users: broadcast to all hosting devices
        groupDevices.forEach(dName => {
          if (deviceSockets[dName]) {
            io.to(deviceSockets[dName]).emit('relayMessage', {
              message: `hello world ${nextGroup}`,
              group: nextGroup,
            });
          }
        });
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});