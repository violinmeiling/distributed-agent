import { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';

// 12 rainbow hex codes
const LAYER_COLORS = [
  '#FF0000', // 1 - Red
  '#FF7F00', // 2 - Orange
  '#FFFF00', // 3 - Yellow
  '#AFFF00', // 4 - Yellow-Green
  '#00FF00', // 5 - Green
  '#00FF7F', // 6 - Spring Green
  '#00FFFF', // 7 - Cyan
  '#007FFF', // 8 - Azure
  '#0000FF', // 9 - Blue
  '#4B00FF', // 10 - Indigo
  '#8B00FF', // 11 - Violet
  '#FF00FF', // 12 - Magenta
];

const IS_PROD = process.env.NODE_ENV === 'production';
const BASE_URL = IS_PROD
  ? 'https://distributed-agent.onrender.com'
  : 'http://localhost:8080';

function App() {
  const [relayLines, setRelayLines] = useState([]);
  const socketRef = useRef(null);
  const [deviceName, setDeviceName] = useState('');
  const [joined, setJoined] = useState(false);
  const [layers, setLayers] = useState([]);
  const [done, setDone] = useState(false);
  const [relayInProgress, setRelayInProgress] = useState(false);
  const [sickoMode, setSickoMode] = useState(false);
  const [root, setRoot] = useState(false);
  const [initiator, setInitiator] = useState('');

  // Connect socket on mount
  useEffect(() => {
    socketRef.current = io(BASE_URL);
    return () => socketRef.current.disconnect();
  }, []);

  // Disconnect on refresh/close
  useEffect(() => {
    const handleBeforeUnload = async () => {
      if (joined && deviceName) {
        await fetch(`${BASE_URL}/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceName }),
          keepalive: true,
        });
        if (socketRef.current) socketRef.current.disconnect();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [joined, deviceName]);

  // Socket event handlers
  useEffect(() => {
    if (joined && deviceName) {
      socketRef.current.emit('register', deviceName);

      socketRef.current.on('updateLayers', ({ layers }) => {
        setLayers(layers);
      });
socketRef.current.on('clearRelay', () => {
  setRelayLines([]);
  setRelayInProgress(true);
});

 socketRef.current.on('relayStarted', () => {
  setRelayLines([{
    text: 'Request initiated',
    color: '#222',
    key: `initiated-${Date.now()}`
  }]);
});

      socketRef.current.on('relayMessage', ({ message, group }) => {
        const groupLayers = Array.from({ length: 4 }, (_, i) => group * 4 + i + 1);
        const hostedLayers = layers.filter(l => groupLayers.includes(l));

        if (hostedLayers.length === 0) {
          // This device doesn't process any layers for this group, just return.
          return;
        }

        // Print "Received input from server" first, then all layers, then (after delay) "Sent output back to server"
        setRelayLines(prev =>
          prev
            .concat({
              text: 'Received input from server',
              color: '#222',
              key: `received-${group}-${Date.now()}`
            })
            .concat(
              hostedLayers.map(l => ({
                text: `Processing layer ${l}`,
                color: LAYER_COLORS[l - 1],
                key: `${group}-${l}-${Date.now()}-${Math.random()}`
              }))
            )
        );

        setTimeout(() => {
          setRelayLines(prev => prev.concat({
            text: 'Sent output back to server',
            color: '#222',
            key: `sent-${group}-${Date.now()}-${Math.random()}`
          }));
          socketRef.current.emit('relayDone', { deviceName, group });
        }, 1000);
      });


      socketRef.current.on('relayFinished', ({ message }) => {
  setRelayLines(prev => prev.concat({ text: message, color: '#222', key: `finished-${Date.now()}` }));
  setRelayInProgress(false);
  setInitiator('');
});

      // Sicko mode state sync
      socketRef.current.on('sickoModeState', ({ enabled }) => {
        setSickoMode(enabled);
      });
    }
    return () => {
      socketRef.current.off('updateLayers');
      socketRef.current.off('clearRelay');
      socketRef.current.off('relayStarted');
      socketRef.current.off('relayMessage');
      socketRef.current.off('relayFinished');
      socketRef.current.off('sickoModeState');
    };
  }, [joined, deviceName, layers]);

  const joinNetwork = async () => {
    if (!deviceName) return;
    if (deviceName === "root") {
      setRoot(true);
    }
    await fetch(`${BASE_URL}/joinNetwork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    setJoined(true);
    setDone(false);
    setRelayLines([]);
    // Fetch assigned layers after joining
    const layersRes = await fetch(`${BASE_URL}/runComputation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    const data = await layersRes.json();
    setLayers(data.layers);
  };

  const disconnect = async () => {
    // Disable sicko mode before disconnecting
    if (root && sickoMode) {
      socketRef.current.emit('disableSickoMode');
    }
    await fetch(`${BASE_URL}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    setJoined(false);
    setLayers([]);
    setDone(false);
    setRelayLines([]);
  };

 const runComputation = () => {
  setInitiator(deviceName); // Mark this device as the initiator
  socketRef.current.emit('startRelay', deviceName);
};

  // Sicko mode logic: just emit, backend handles interval and sync
  const startSickoMode = () => {
    socketRef.current.emit('enableSickoMode');
  };

  const stopSickoMode = () => {
    socketRef.current.emit('disableSickoMode');
  };

  return (
    <div>
      <h2>Assigned Layers:</h2>
      <p>{layers.join(', ')}</p>
      {done && <h2>✅ Computation Completed</h2>}
      <input
        type="text"
        placeholder="Enter device name"
        value={deviceName}
        onChange={e => setDeviceName(e.target.value)}
        disabled={joined}
      />
      <button onClick={joinNetwork} disabled={!deviceName || joined}>
        Join Network
      </button>
      <button onClick={disconnect} disabled={!joined}>
        Disconnect
      </button>
      <button onClick={runComputation} disabled={!joined}>
        Run Computation
      </button>
      <button onClick={startSickoMode} disabled={!joined || !root || sickoMode}>
        Enable Simulation Mode
      </button>
      <button onClick={stopSickoMode} disabled={!joined || !root || !sickoMode}>
        Disable Simulation Mode
      </button>
      <div style={{ margin: '1em 0', minHeight: 120 }}>
        {relayLines.map(line => (
          <div key={line.key} style={{ color: line.color }}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;