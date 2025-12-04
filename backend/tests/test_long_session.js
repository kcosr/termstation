#!/usr/bin/env node

/**
 * Test script to verify WebSocket duplication fix with a longer session
 * This creates a session that outputs over a longer period and tests reconnection
 */

import { WebSocket } from 'ws';

const SERVER_URL = 'http://localhost:6620';
const WS_URL = 'ws://localhost:6620';

let sessionId = null;
let receivedMessages = new Map(); // clientId -> messages[]

// Utility function to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to create a long-running session
async function createLongSession() {
  const response = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'for i in {1..10}; do echo "Message $i from session"; sleep 1; done',
      working_directory: '/tmp',
      interactive: false,
      cols: 80,
      rows: 24
    })
  });
  
  const session = await response.json();
  sessionId = session.session_id;
  console.log(`✓ Created long-running session: ${sessionId}`);
  return sessionId;
}

// Function to connect WebSocket and attach to session
function connectWebSocket(clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/${clientId}`);
    receivedMessages.set(clientId, []);
    
    ws.on('open', () => {
      console.log(`✓ WebSocket connected for client ${clientId}`);
      
      ws.send(JSON.stringify({
        type: 'attach',
        session_id: sessionId
      }));
      
      resolve(ws);
    });
    
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'stdout') {
        const clientMessages = receivedMessages.get(clientId);
        clientMessages.push({
          content: message.data.trim(),
          timestamp: Date.now()
        });
        console.log(`📨 Client ${clientId}: ${message.data.trim()}`);
      }
    });
    
    ws.on('error', (error) => {
      console.error(`❌ WebSocket error for client ${clientId}:`, error);
      reject(error);
    });
  });
}

// Main test function
async function runLongTest() {
  console.log('🚀 Starting long session WebSocket test...\n');
  
  try {
    // Step 1: Create a long-running session
    console.log('1️⃣ Creating long-running test session...');
    await createLongSession();
    await sleep(500);
    
    // Step 2: First client connects and gets some messages
    console.log('\n2️⃣ First client connecting...');
    const client1 = await connectWebSocket('client-1');
    await sleep(3000); // Let it get some messages
    
    // Step 3: Simulate page refresh - disconnect and reconnect while session is still running
    console.log('\n3️⃣ Simulating page refresh (disconnect and reconnect)...');
    client1.close();
    await sleep(500);
    
    const client1Reconnect = await connectWebSocket('client-1-reconnect');
    await sleep(3000); // Get more messages
    
    // Step 4: Add a second fresh client while both session and first client are active
    console.log('\n4️⃣ Adding second client while session is still active...');
    const client2 = await connectWebSocket('client-2');
    await sleep(4000); // Let both clients receive remaining messages
    
    // Clean up connections
    client1Reconnect.close();
    client2.close();
    await sleep(500);
    
    // Step 5: Analyze results
    console.log('\n📊 Test Results:');
    console.log('================');
    
    const client1Messages = receivedMessages.get('client-1') || [];
    const client1ReconnectMessages = receivedMessages.get('client-1-reconnect') || [];
    const client2Messages = receivedMessages.get('client-2') || [];
    
    console.log(`Client 1 (initial): ${client1Messages.length} messages`);
    console.log(`Client 1 (reconnect): ${client1ReconnectMessages.length} messages`);  
    console.log(`Client 2 (concurrent): ${client2Messages.length} messages`);
    
    // Check for content overlap between reconnected client and concurrent client
    const reconnectContent = client1ReconnectMessages.map(m => m.content);
    const concurrentContent = client2Messages.map(m => m.content);
    
    // Find overlapping messages (both clients should get same messages during concurrent period)
    const overlappingMessages = reconnectContent.filter(msg => 
      concurrentContent.includes(msg)
    );
    
    console.log(`\nOverlapping messages (concurrent period): ${overlappingMessages.length}`);
    console.log(`Reconnect client messages:`, reconnectContent);
    console.log(`Concurrent client messages:`, concurrentContent);
    
    // Test results
    let testPassed = true;
    let issues = [];
    
    // Check if clients are getting similar numbers of concurrent messages
    const expectedConcurrentMessages = Math.min(reconnectContent.length, concurrentContent.length);
    if (expectedConcurrentMessages > 0 && overlappingMessages.length === 0) {
      issues.push("Clients should receive same messages during concurrent period");
      testPassed = false;
    }
    
    // Check for excessive duplication (each message should appear once per client)
    const allMessages = [...reconnectContent, ...concurrentContent];
    const messageFrequency = {};
    allMessages.forEach(msg => {
      messageFrequency[msg] = (messageFrequency[msg] || 0) + 1;
    });
    
    const excessiveDuplication = Object.entries(messageFrequency).filter(
      ([msg, count]) => count > 2 // More than 2 means duplication within same client
    );
    
    if (excessiveDuplication.length > 0) {
      issues.push(`Excessive duplication detected: ${excessiveDuplication.map(([msg, count]) => `"${msg}": ${count} times`).join(', ')}`);
      testPassed = false;
    }
    
    if (testPassed) {
      console.log('\n✅ TEST PASSED: No duplication issues detected');
    } else {
      console.log('\n❌ TEST FAILED:');
      issues.forEach(issue => console.log(`  - ${issue}`));
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
  
  console.log('\n🏁 Test complete');
}

// Start the test
runLongTest();