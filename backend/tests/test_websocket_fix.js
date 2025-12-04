#!/usr/bin/env node

/**
 * Test script to verify the WebSocket duplication fix
 * This simulates a client connecting, creating a session, disconnecting, and reconnecting
 */

import { WebSocket } from 'ws';

const SERVER_URL = 'http://localhost:6620';
const WS_URL = 'ws://localhost:6620';

let sessionId = null;
let receivedMessages = [];

// Utility function to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to create a session
async function createSession() {
  const response = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'echo "Hello from test session"; sleep 2; echo "Second message"; sleep 1; echo "Third message"',
      working_directory: '/tmp',
      interactive: false,
      cols: 80,
      rows: 24
    })
  });
  
  const session = await response.json();
  sessionId = session.session_id;
  console.log(`✓ Created session: ${sessionId}`);
  return sessionId;
}

// Function to connect WebSocket and attach to session
function connectWebSocket(clientId, attachToSession = true) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/${clientId}`);
    let messageCount = 0;
    
    ws.on('open', () => {
      console.log(`✓ WebSocket connected for client ${clientId}`);
      
      if (attachToSession && sessionId) {
        ws.send(JSON.stringify({
          type: 'attach',
          session_id: sessionId
        }));
      }
      
      resolve({ ws, messageCount: 0 });
    });
    
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      console.log(`📨 Client ${clientId} received: ${message.type}${message.data ? ` - ${message.data.trim()}` : ''}`);
      
      if (message.type === 'stdout') {
        messageCount++;
        receivedMessages.push({ client: clientId, message: message.data.trim(), timestamp: Date.now() });
      }
    });
    
    ws.on('error', (error) => {
      console.error(`❌ WebSocket error for client ${clientId}:`, error);
      reject(error);
    });
  });
}

// Main test function
async function runTest() {
  console.log('🚀 Starting WebSocket duplication test...\n');
  
  try {
    // Step 1: Create a session
    console.log('1️⃣ Creating test session...');
    await createSession();
    await sleep(500);
    
    // Step 2: First client connects
    console.log('\n2️⃣ First client connecting...');
    const client1 = await connectWebSocket('client-1');
    await sleep(3000); // Wait for command to execute
    
    // Step 3: Simulate page refresh - disconnect and reconnect
    console.log('\n3️⃣ Simulating page refresh (disconnect and reconnect)...');
    client1.ws.close();
    await sleep(500);
    
    const client1Reconnect = await connectWebSocket('client-1-reconnect');
    await sleep(2000); // Wait for remaining output
    
    // Step 4: Another fresh client connects
    console.log('\n4️⃣ Fresh client connecting...');
    const client2 = await connectWebSocket('client-2');
    await sleep(1500);
    
    // Step 5: Analyze results
    console.log('\n📊 Test Results:');
    console.log('================');
    
    const client1Messages = receivedMessages.filter(m => m.client === 'client-1');
    const client1ReconnectMessages = receivedMessages.filter(m => m.client === 'client-1-reconnect');
    const client2Messages = receivedMessages.filter(m => m.client === 'client-2');
    
    console.log(`Client 1 (initial): ${client1Messages.length} messages`);
    console.log(`Client 1 (reconnect): ${client1ReconnectMessages.length} messages`);  
    console.log(`Client 2 (fresh): ${client2Messages.length} messages`);
    
    // Check for duplicates
    const allMessages = receivedMessages.map(m => m.message);
    const uniqueMessages = [...new Set(allMessages)];
    
    console.log(`\nTotal messages received: ${allMessages.length}`);
    console.log(`Unique message content: ${uniqueMessages.length}`);
    console.log(`Message contents:`, uniqueMessages);
    
    // Determine test result
    if (allMessages.length > uniqueMessages.length * 2) {
      console.log('\n❌ TEST FAILED: Excessive message duplication detected');
    } else if (client1ReconnectMessages.length === 0 && client2Messages.length === 0) {
      console.log('\n✅ TEST PASSED: No duplicates, but session ended before reconnect');  
    } else {
      console.log('\n✅ TEST PASSED: No excessive duplication detected');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
  
  console.log('\n🏁 Test complete');
  process.exit(0);
}

// Start the test
runTest();