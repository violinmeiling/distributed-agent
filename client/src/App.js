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

function App() {
  const [relayLines, setRelayLines] = useState([]); // Array of {text, color}
  const socketRef = useRef(null);
  const [deviceName, setDeviceName] = useState('');
  const [joined, setJoined] = useState(false);
  const [layers, setLayers] = useState([]);
  const [done, setDone] = useState(false);
  const [relayInProgress, setRelayInProgress] = useState(false);
  const [sickoMode, setSickoMode] = useState(false);
  const sickoIntervalRef = useRef(null);
  const [root, setRoot] = useState(false);

  // Connect socket on mount
  useEffect(() => {
    socketRef.current = io('https://distributed-agent.onrender.com');
    return () => socketRef.current.disconnect();
  }, []);

  // Disconnect on refresh/close
  useEffect(() => {
    const handleBeforeUnload = async () => {
      if (joined && deviceName) {
        await fetch('https://distributed-agent.onrender.com/disconnect', {
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
        setRelayInProgress(true); // Mark relay as started
      });

      socketRef.current.on('relayStarted', () => {
        setRelayLines(prev => prev.concat({
          text: 'hello world started',
          color: '#222',
          key: `started-${Date.now()}`
        }));
      });

      socketRef.current.on('relayMessage', ({ message, group }) => {
        const groupLayers = Array.from({ length: 4 }, (_, i) => group * 4 + i + 1);
        const hostedLayers = layers.filter(l => groupLayers.includes(l));
        setRelayLines(prev =>
          prev.concat(
            hostedLayers.map(l => ({
              text: 'hello world',
              color: LAYER_COLORS[l - 1],
              key: `${group}-${l}-${Date.now()}-${Math.random()}`
            }))
          )
        );
        setTimeout(() => {
          socketRef.current.emit('relayDone', { deviceName, group });
        }, 1000);
      });

      socketRef.current.on('relayFinished', ({ message }) => {
        setRelayLines(prev => prev.concat({ text: message, color: '#222', key: `finished-${Date.now()}` }));
        setRelayInProgress(false); // Mark relay as finished
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

  // Helper to fetch all device names from backend
  const fetchDeviceNames = async () => {
    const res = await fetch('https://distributed-agent.onrender.com/devices');
    return await res.json();
  };

  const joinNetwork = async () => {
    if (!deviceName) return;
    if (deviceName == "root") {
      setRoot(true);
    }
    await fetch('https://distributed-agent.onrender.com/joinNetwork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    setJoined(true);
    setDone(false);
    setRelayLines([]);
    // Fetch assigned layers after joining
    const layersRes = await fetch('https://distributed-agent.onrender.com/runComputation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    const data = await layersRes.json();
    setLayers(data.layers);
  };

  const disconnect = async () => {
    await fetch('https://distributed-agent.onrender.com/disconnect', {
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
    setRelayLines([]); // Clear previous relay lines
    socketRef.current.emit('startRelay', deviceName);
  };

  // Sicko mode logic
  const startSickoMode = async () => {
    socketRef.current.emit('enableSickoMode');
    setRelayInProgress(false); // Ensure clean start
    sickoIntervalRef.current = setInterval(async () => {
      if (relayInProgress) return; // Wait for previous relay to finish
      const devices = await fetchDeviceNames();
      if (devices.length === 0) return;
      const randomDevice = devices[Math.floor(Math.random() * devices.length)];
      setRelayInProgress(true);
      socketRef.current.emit('startRelay', randomDevice);
    }, 500); // check every 500ms, but only start if not in progress
  };

  const stopSickoMode = () => {
    socketRef.current.emit('disableSickoMode');
    if (sickoIntervalRef.current) clearInterval(sickoIntervalRef.current);
  };

  // Cleanup sicko interval on unmount
  useEffect(() => {
    return () => {
      if (sickoIntervalRef.current) clearInterval(sickoIntervalRef.current);
    };
  }, []);

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
      <button onClick={startSickoMode} disabled={!root || sickoMode}>
        Enable Sicko Mode
      </button>
      <button onClick={stopSickoMode} disabled={!root || !sickoMode}>
        Disable Sicko Mode
      </button>
      {/* Relay output below controls, normal font */}
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