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
const groupToDeviceTable = {}; // { groupIdx: [deviceName] }
const layersToGroupTable = {}; // { layerNum: groupIdx }
const deviceSockets = {}; // { deviceName: socket.id }
const TOTAL_LAYERS = 12;
const GROUP_SIZE = 4; // 3 groups of 4 layers each
let sickoModeActive = false;

function resetGroups() {
  for (let i = 0; i < 3; i++) groupToDeviceTable[i] = [];
  for (let i = 1; i <= TOTAL_LAYERS; i++) layersToGroupTable[i] = Math.floor((i - 1) / GROUP_SIZE);
}

// Assign one group per device, backend hosts the rest
function redistributeLayers() {
  resetGroups();
  // Find all devices currently assigned to groups
  const currentAssignments = {};
  const assignedDevices = new Set();

  // Build a reverse lookup: which device has which group
  Object.entries(deviceTable).forEach(([deviceName, layers]) => {
    if (layers.length > 0) {
      const groupIdx = layersToGroupTable[layers[0]];
      currentAssignments[groupIdx] = deviceName;
      assignedDevices.add(deviceName);
    }
  });

  // Assign groups 0, 1, 2
  let unassignedDevices = Object.keys(deviceTable).filter(
    d => !assignedDevices.has(d)
  );
  for (let group = 0; group < 3; group++) {
    if (currentAssignments[group] && deviceTable[currentAssignments[group]]) {
      groupToDeviceTable[group] = [currentAssignments[group]];
      // Ensure device has correct layers
      const groupLayers = [];
      for (let l = 1; l <= TOTAL_LAYERS; l++) {
        if (layersToGroupTable[l] === group) groupLayers.push(l);
      }
      deviceTable[currentAssignments[group]] = groupLayers;
    } else if (unassignedDevices.length > 0) {
      // Assign this group to an unassigned device
      const deviceName = unassignedDevices.shift();
      groupToDeviceTable[group] = [deviceName];
      const groupLayers = [];
      for (let l = 1; l <= TOTAL_LAYERS; l++) {
        if (layersToGroupTable[l] === group) groupLayers.push(l);
      }
      deviceTable[deviceName] = groupLayers;
      currentAssignments[group] = deviceName;
      assignedDevices.add(deviceName);
    } else {
      // No device for this group, backend will handle it
      groupToDeviceTable[group] = [];
    }
  }

  // Remove group assignments from any extra devices (shouldn't happen, but safe)
  Object.keys(deviceTable).forEach(deviceName => {
    const layers = deviceTable[deviceName];
    if (
      layers.length > 0 &&
      !Object.values(currentAssignments).includes(deviceName)
    ) {
      deviceTable[deviceName] = [];
    }
  });

  // Push updated layers to all connected devices
  Object.keys(deviceTable).forEach(deviceName => {
    const socketId = deviceSockets[deviceName];
    if (socketId) {
      io.to(socketId).emit('updateLayers', { layers: deviceTable[deviceName] });
    }
  });
  console.log('deviceTable:', deviceTable);
}

// Simulate backend processing for a group
function backendProcessGroup(group) {
  const groupLayers = [];
  for (let l = 1; l <= TOTAL_LAYERS; l++) {
    if (layersToGroupTable[l] === group) groupLayers.push(l);
  }
  groupLayers.forEach(l => {
    console.log(`Backend processing layer ${l}`);
  });
  setTimeout(() => {
    console.log('Backend: Sent output back to server for group', group);
    relayDoneFromBackend(group);
  }, 1000);
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
    const groupDevices = groupToDeviceTable[nextGroup] || [];
    if (groupDevices.length > 0) {
      // Usual device logic
      groupDevices.forEach(dName => {
        if (deviceSockets[dName]) {
          io.to(deviceSockets[dName]).emit('relayMessage', {
            message: `hello world ${nextGroup}`,
            group: nextGroup,
          });
        }
      });
    } else {
      // Backend processes this group
      backendProcessGroup(nextGroup);
    }
  }
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
    delete deviceTable[deviceName];
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
  const groupDevices = groupToDeviceTable[0] || [];
  if (groupDevices.length > 0) {
    groupDevices.forEach(dName => {
      if (deviceSockets[dName]) {
        io.to(deviceSockets[dName]).emit('relayMessage', {
          message: 'hello world 0',
          group: 0,
        });
      }
    });
  } else {
    backendProcessGroup(0);
  }
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
      const groupDevices = groupToDeviceTable[nextGroup] || [];
      if (groupDevices.length > 0) {
        groupDevices.forEach(dName => {
          if (deviceSockets[dName]) {
            io.to(deviceSockets[dName]).emit('relayMessage', {
              message: `hello world ${nextGroup}`,
              group: nextGroup,
            });
          }
        });
      } else {
        backendProcessGroup(nextGroup);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});