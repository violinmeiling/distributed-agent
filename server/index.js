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
const groupToDeviceTable = {}; // { groupIdx: [deviceName, ...] }
const layersToGroupTable = {}; // { layerNum: groupIdx }
const deviceSockets = {}; // { deviceName: socket.id }
const deviceTriggerCounts = {}; // { deviceName: number }
const TOTAL_LAYERS = 12;
const GROUP_SIZE = 4; // 3 groups of 4 layers each
let sickoModeActive = false;

function resetGroups() {
  for (let i = 0; i < 3; i++) groupToDeviceTable[i] = [];
  for (let i = 1; i <= TOTAL_LAYERS; i++) layersToGroupTable[i] = Math.floor((i - 1) / GROUP_SIZE);
}

resetGroups();

function redistributeLayers() {
  // 1. Remove disconnected devices from groupToDeviceTable
  for (let group = 0; group < 3; group++) {
    if (!groupToDeviceTable[group]) groupToDeviceTable[group] = [];
    groupToDeviceTable[group] = groupToDeviceTable[group].filter(deviceName => deviceTable.hasOwnProperty(deviceName));
  }

  // 2. Find all assigned devices
  const assigned = new Set(Object.values(groupToDeviceTable).flat());

  // 3. Assign unassigned devices to the group with the fewest devices
  const unassignedDevices = Object.keys(deviceTable).filter(d => !assigned.has(d));
  for (const deviceName of unassignedDevices) {
    // Find group with fewest devices
    let minGroup = 0;
    let minCount = groupToDeviceTable[0].length;
    for (let g = 1; g < 3; g++) {
      if (groupToDeviceTable[g].length < minCount) {
        minGroup = g;
        minCount = groupToDeviceTable[g].length;
      }
    }
    groupToDeviceTable[minGroup].push(deviceName);
  }

  // 4. Assign layers to each device based on their group(s)
  for (let group = 0; group < 3; group++) {
    const groupLayers = [];
    for (let l = 1; l <= TOTAL_LAYERS; l++) {
      if (layersToGroupTable[l] === group) groupLayers.push(l);
    }
    for (const deviceName of groupToDeviceTable[group]) {
      deviceTable[deviceName] = groupLayers;
    }
  }

  // 5. Push updated layers to all connected devices
  Object.keys(deviceTable).forEach(deviceName => {
    const socketId = deviceSockets[deviceName];
    if (socketId) {
      io.to(socketId).emit('updateLayers', { layers: deviceTable[deviceName] });
    }
  });
  console.log('deviceTable:', deviceTable);
  console.log('groupToDeviceTable:', groupToDeviceTable);
}

// Backend relayDone logic
function relayDoneFromBackend(group) {
  if (!relayState || group !== relayState.currentGroup) return;
  relayState.currentGroup += 1;
  if (relayState.currentGroup > 2) {
    const originSocket = deviceSockets[relayState.originDevice];
    if (originSocket) {
      io.to(originSocket).emit('relayFinished', { message: 'Request completed' });
    }
    relayState = null;
    if (sickoModeActive) {
      setTimeout(() => {
        startSickoComputation();
      }, 1000);
    }
  } else {
    const nextGroup = relayState.currentGroup;
    routeRelayToGroup(nextGroup);
  }
}

function backendProcessGroup(groupIdx) {
  const groupLayers = [];
  for (let l = 1; l <= TOTAL_LAYERS; l++) {
    if (layersToGroupTable[l] === groupIdx) groupLayers.push(l);
  }
  groupLayers.forEach(l => {
    console.log(`Backend processing layer ${l}`);
  });
  setTimeout(() => {
    console.log('Backend: Sent output back to server for group', groupIdx);
    relayDoneFromBackend(groupIdx);
  }, 1000);
}

// Route relay to the device in the group with the lowest trigger count
function routeRelayToGroup(groupIdx) {
  const groupDevices = groupToDeviceTable[groupIdx] || [];
  if (groupDevices.length > 0) {
    // Choose the device with the lowest trigger count
    let chosen = groupDevices[0];
    let minCount = deviceTriggerCounts[chosen] || 0;
    groupDevices.forEach(dName => {
      if ((deviceTriggerCounts[dName] || 0) < minCount) {
        chosen = dName;
        minCount = deviceTriggerCounts[dName] || 0;
      }
    });
    deviceTriggerCounts[chosen] = (deviceTriggerCounts[chosen] || 0) + 1;
    if (deviceSockets[chosen]) {
      io.to(deviceSockets[chosen]).emit('relayMessage', {
        message: `hello world ${groupIdx}`,
        group: groupIdx,
      });
    }
  } else {
    backendProcessGroup(groupIdx);
  }
}

app.post('/joinNetwork', (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) return res.status(400).send('Device name required');
  if (!deviceTable[deviceName]) {
    deviceTable[deviceName] = [];
    deviceTriggerCounts[deviceName] = 0;
    redistributeLayers();
    console.log(`Device joined: ${deviceName}`);
  }
  res.sendStatus(200);
});

app.post('/disconnect', (req, res) => {
  const { deviceName } = req.body;
  if (deviceTable[deviceName]) {
    delete deviceTable[deviceName];
    delete deviceTriggerCounts[deviceName];
    Object.values(groupToDeviceTable).forEach(arr => {
      const idx = arr.indexOf(deviceName);
      if (idx !== -1) arr.splice(idx, 1);
    });
    redistributeLayers();
    console.log(`Device disconnected: ${deviceName}`);
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

function startRelayOrSicko(originDevice) {
  io.emit('clearRelay');
  // Emit relayStarted to the initiator device
  if (deviceSockets[originDevice]) {
    io.to(deviceSockets[originDevice]).emit('relayStarted');
  }
  relayState = {
    originDevice,
    currentGroup: 0,
    groupsOrder: [0, 1, 2],
  };
  // Start with group 0
  routeRelayToGroup(0);
}

function startSickoComputation() {
  if (!sickoModeActive) return;
  const deviceNames = Object.keys(deviceTable);
  if (deviceNames.length === 0) return;
  const randomDevice = deviceNames[Math.floor(Math.random() * deviceNames.length)];
  startRelayOrSicko(randomDevice);
}

io.on('connection', (socket) => {
  socket.on('register', (deviceName) => {
    deviceSockets[deviceName] = socket.id;
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

  socket.emit('sickoModeState', { enabled: sickoModeActive });

  socket.on('startRelay', (deviceName) => {
    startRelayOrSicko(deviceName);
  });

  socket.on('relayDone', ({ deviceName, group }) => {
    if (!relayState || group !== relayState.currentGroup) return;
    relayState.currentGroup += 1;
    if (relayState.currentGroup > 2) {
      const originSocket = deviceSockets[relayState.originDevice];
      if (originSocket) {
        io.to(originSocket).emit('relayFinished', { message: 'Request completed' });
      }
      relayState = null;
      if (sickoModeActive) {
        setTimeout(() => {
          startSickoComputation();
        }, 1000);
      }
    } else {
      const nextGroup = relayState.currentGroup;
      routeRelayToGroup(nextGroup);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});