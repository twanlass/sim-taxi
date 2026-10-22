import React, { useState, useEffect, useRef } from 'react';

const MagicalForestGame = () => {
  const canvasRef = useRef(null);
  const [score, setScore] = useState({ food: 0, wood: 0 });
  const scoreRef = useRef({ food: 0, wood: 0 });
  
  // Keep scoreRef in sync with score state
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);
  
  const gameStateRef = useRef({
    player: {
      x: 100,
      y: 0,
      width: 32,
      height: 32,
      velocityY: 0,
      isGrounded: false,
      speed: 5
    },
    keys: {},
    gravity: 0.8,
    jumpStrength: -15,
    groundY: 450,
    collectibles: [],
    obstacles: []
  });

  // Initialize game objects
  useEffect(() => {
    const state = gameStateRef.current;
    
    // Create collectibles
    state.collectibles = [
      { x: 200, y: 400, type: 'food', collected: false },
      { x: 350, y: 380, type: 'food', collected: false },
      { x: 500, y: 420, type: 'food', collected: false },
      { x: 650, y: 390, type: 'food', collected: false },
      { x: 800, y: 410, type: 'food', collected: false },
    ];

    // Create obstacles
    state.obstacles = [];

    // Create trees (can be chopped down)
    state.trees = [
      { x: 150, y: 300, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
      { x: 400, y: 280, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
      { x: 600, y: 310, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
      { x: 850, y: 290, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
      { x: 50, y: 320, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
      { x: 920, y: 305, chops: 0, chopped: false, scale: 1, onFire: false, burnProgress: 0, hasApples: false },
    ];
    
    state.isChopping = false;
    state.chopCooldown = 0;
    state.currentlyChoppingTree = null; // Track which tree is being chopped
    
    // Seeds and growing trees
    state.seeds = [];
    state.seedCooldown = 0;
    
    // Lightning and fire mechanics
    state.lightningCooldown = 0;
    state.lightningMinInterval = 600; // Minimum frames between checks (10 seconds)
    state.lightningMaxInterval = 1800; // Maximum frames between checks (30 seconds)
    state.nextLightningCheck = Math.random() * (state.lightningMaxInterval - state.lightningMinInterval) + state.lightningMinInterval;
    state.lightningStrikeChance = 0.2; // 20% chance of strike when check occurs
    state.activeLightning = null;
    
    // Houses
    state.houses = [];
    
    // AI workers
    state.aiWorkers = [];
    
    // Day/night cycle
    state.dayNightCycle = 0; // 0-1 where 0 is midnight, 0.5 is noon
    state.dayNightSpeed = 1 / (60 * 60); // Full cycle in 60 seconds (60 seconds * 60 fps)
  }, []);

  // Keyboard handling
  useEffect(() => {
    const handleKeyDown = (e) => {
      gameStateRef.current.keys[e.key] = true;
      
      // Jump
      if ((e.key === 'ArrowUp' || e.key === ' ') && gameStateRef.current.player.isGrounded) {
        gameStateRef.current.player.velocityY = gameStateRef.current.jumpStrength;
        gameStateRef.current.player.isGrounded = false;
      }
      
      // Chop (C key)
      if (e.key === 'c' || e.key === 'C') {
        const state = gameStateRef.current;
        const currentFood = scoreRef.current.food;
        
        // Need 0.5 food to chop
        if (currentFood < 0.5) {
          console.log('Need 0.5 food (apple) to chop trees!');
          return;
        }
        
        if (state.chopCooldown <= 0 && !state.isChopping) {
          state.isChopping = true;
          state.chopCooldown = 20; // Frames before can chop again
          
          // Check if near any tree
          const player = state.player;
          
          // If already chopping a tree, continue with that tree
          if (state.currentlyChoppingTree && !state.currentlyChoppingTree.chopped) {
            const tree = state.currentlyChoppingTree;
            const distance = Math.abs((tree.x + 15) - (player.x + player.width / 2));
            
            if (distance < 60 && player.y + player.height >= state.groundY - 10) {
              // First chop costs 0.5 food
              if (tree.chops === 0) {
                setScore(prev => ({
                  ...prev,
                  food: prev.food - 0.5
                }));
              }
              
              tree.chops++;
              if (tree.chops >= 5) {
                // Tree is fully chopped
                setTimeout(() => {
                  tree.chopped = true;
                  state.currentlyChoppingTree = null; // Release the tree
                  
                  // Add wood collectibles based on tree size
                  const treeScale = tree.scale || 1;
                  let woodAmount = 1;
                  if (treeScale >= 1.2) woodAmount = 3;
                  else if (treeScale >= 0.9) woodAmount = 2;
                  
                  for (let i = 0; i < woodAmount; i++) {
                    state.collectibles.push({
                      x: tree.x + 10 + (i * 15) - (woodAmount * 7),
                      y: state.groundY - 30,
                      type: 'wood',
                      collected: false
                    });
                  }
                  
                  // If tree has apples, drop apples too
                  if (tree.hasApples) {
                    state.collectibles.push({
                      x: tree.x + 25,
                      y: state.groundY - 30,
                      type: 'food',
                      collected: false
                    });
                    state.collectibles.push({
                      x: tree.x - 5,
                      y: state.groundY - 30,
                      type: 'food',
                      collected: false
                    });
                  }
                }, 300);
              }
            } else {
              // Too far from current tree, cancel chopping
              state.currentlyChoppingTree = null;
            }
          } else {
            // Find a new tree to chop
            let foundTree = null;
            state.trees.forEach(tree => {
              if (!tree.chopped && !foundTree) {
                const distance = Math.abs((tree.x + 15) - (player.x + player.width / 2));
                if (distance < 60 && player.y + player.height >= state.groundY - 10) {
                  foundTree = tree;
                }
              }
            });
            
            if (foundTree) {
              state.currentlyChoppingTree = foundTree;
              
              // First chop costs 0.5 food
              setScore(prev => ({
                ...prev,
                food: prev.food - 0.5
              }));
              
              foundTree.chops++;
              if (foundTree.chops >= 5) {
                // Tree is fully chopped
                setTimeout(() => {
                  foundTree.chopped = true;
                  state.currentlyChoppingTree = null; // Release the tree
                  
                  // Add wood collectibles based on tree size
                  const treeScale = foundTree.scale || 1;
                  let woodAmount = 1;
                  if (treeScale >= 1.2) woodAmount = 3;
                  else if (treeScale >= 0.9) woodAmount = 2;
                  
                  for (let i = 0; i < woodAmount; i++) {
                    state.collectibles.push({
                      x: foundTree.x + 10 + (i * 15) - (woodAmount * 7),
                      y: state.groundY - 30,
                      type: 'wood',
                      collected: false
                    });
                  }
                  
                  // If tree has apples, drop apples too
                  if (foundTree.hasApples) {
                    state.collectibles.push({
                      x: foundTree.x + 25,
                      y: state.groundY - 30,
                      type: 'food',
                      collected: false
                    });
                    state.collectibles.push({
                      x: foundTree.x - 5,
                      y: state.groundY - 30,
                      type: 'food',
                      collected: false
                    });
                  }
                }, 300);
              }
            }
          }
        }
      }
      
      // Plant seed (S key)
      if (e.key === 's' || e.key === 'S') {
        const state = gameStateRef.current;
        if (state.seedCooldown <= 0 && state.player.isGrounded) {
          state.seedCooldown = 30; // Cooldown before can plant again
          
          // Plant seed at player position with random scale
          state.seeds.push({
            x: state.player.x + state.player.width / 2 - 5,
            y: state.groundY - 10,
            age: 0,
            maxAge: 180 + Math.random() * 36, // 180-216 frames (3-3.6 seconds)
            scale: 0.6 + Math.random() * 0.8, // Random scale between 0.6 and 1.4
            hasApples: Math.random() < 0.4 // 40% chance of growing apples
          });
        }
      }
      
      // Build house (H key)
      if (e.key === 'h' || e.key === 'H') {
        const state = gameStateRef.current;
        const currentWood = scoreRef.current.wood;
        
        if (currentWood >= 10 && state.player.isGrounded) {
          // Spend 10 wood
          setScore(prev => ({
            ...prev,
            wood: prev.wood - 10
          }));
          
          // Build house at player position
          const houseId = Date.now() + Math.random(); // Unique ID for the house
          const newHouse = {
            id: houseId,
            x: state.player.x - 20,
            y: state.groundY,
            onFire: false,
            burnProgress: 0
          };
          state.houses.push(newHouse);
          
          // Spawn AI worker for this house
          const workerColors = ['#e24a4a', '#4ae24a', '#e2e24a', '#e24ae2', '#4ae2e2'];
          state.aiWorkers.push({
            houseId: houseId, // Link worker to house
            x: newHouse.x + 40,
            y: state.groundY - 32,
            width: 32,
            height: 32,
            velocityY: 0,
            isGrounded: false,
            color: workerColors[state.aiWorkers.length % workerColors.length],
            targetTree: null,
            choppingProgress: 0,
            state: 'idle', // idle, moving_to_tree, chopping, returning_home
            homeX: newHouse.x + 40
          });
          
          console.log('House built! Total houses:', state.houses.length);
        } else if (currentWood < 10) {
          console.log('Not enough wood! Need 10, have:', currentWood);
        } else if (!state.player.isGrounded) {
          console.log('Must be on ground to build!');
        }
      }
    };

    const handleKeyUp = (e) => {
      gameStateRef.current.keys[e.key] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationFrameId;

    const gameLoop = () => {
      const state = gameStateRef.current;
      const player = state.player;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Update day/night cycle
      state.dayNightCycle = (state.dayNightCycle + state.dayNightSpeed) % 1;
      
      // Calculate sky colors based on time of day
      const timeOfDay = state.dayNightCycle;
      let skyColor1, skyColor2, skyColor3;
      
      if (timeOfDay < 0.25) {
        // Night (0.0 - 0.25) - midnight to sunrise
        const nightProgress = timeOfDay / 0.25;
        const r = Math.floor(42 * (1 - nightProgress) + 42 * nightProgress);
        const g = Math.floor(26 * (1 - nightProgress) + 42 * nightProgress);
        const b = Math.floor(74 * (1 - nightProgress) + 84 * nightProgress);
        skyColor1 = `rgb(${r}, ${g}, ${b})`;
        skyColor2 = `rgb(${Math.floor(r * 1.2)}, ${Math.floor(g * 1.2)}, ${Math.floor(b * 1.2)})`;
        skyColor3 = `rgb(${Math.floor(r * 0.8)}, ${Math.floor(g * 1.5)}, ${Math.floor(g * 0.9)})`;
      } else if (timeOfDay < 0.5) {
        // Dawn to day (0.25 - 0.5) - sunrise to noon
        const dawnProgress = (timeOfDay - 0.25) / 0.25;
        const r = Math.floor(42 + (135 - 42) * dawnProgress);
        const g = Math.floor(42 + (206 - 42) * dawnProgress);
        const b = Math.floor(84 + (235 - 84) * dawnProgress);
        skyColor1 = `rgb(${r}, ${g}, ${b})`;
        skyColor2 = `rgb(${Math.floor(r * 1.1)}, ${Math.floor(g * 1.1)}, ${Math.floor(b * 1.1)})`;
        skyColor3 = `rgb(${Math.floor(r * 0.9)}, ${Math.floor(g * 0.95)}, ${Math.floor(b * 0.9)})`;
      } else if (timeOfDay < 0.75) {
        // Day to dusk (0.5 - 0.75) - noon to sunset
        const dayProgress = (timeOfDay - 0.5) / 0.25;
        const r = Math.floor(135 + (180 - 135) * dayProgress);
        const g = Math.floor(206 + (100 - 206) * dayProgress);
        const b = Math.floor(235 + (120 - 235) * dayProgress);
        skyColor1 = `rgb(${r}, ${g}, ${b})`;
        skyColor2 = `rgb(${Math.floor(r * 1.1)}, ${Math.floor(g * 0.9)}, ${Math.floor(b * 0.85)})`;
        skyColor3 = `rgb(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.9)})`;
      } else {
        // Dusk to night (0.75 - 1.0) - sunset to midnight
        const duskProgress = (timeOfDay - 0.75) / 0.25;
        const r = Math.floor(180 + (42 - 180) * duskProgress);
        const g = Math.floor(100 + (26 - 100) * duskProgress);
        const b = Math.floor(120 + (74 - 120) * duskProgress);
        skyColor1 = `rgb(${r}, ${g}, ${b})`;
        skyColor2 = `rgb(${Math.floor(r * 1.2)}, ${Math.floor(g * 1.2)}, ${Math.floor(b * 1.2)})`;
        skyColor3 = `rgb(${Math.floor(r * 0.8)}, ${Math.floor(g * 1.2)}, ${Math.floor(b * 0.9)})`;
      }

      // Draw sky with gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, skyColor1);
      gradient.addColorStop(0.5, skyColor2);
      gradient.addColorStop(1, skyColor3);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw sun or moon
      const celestialY = 100 + Math.sin(timeOfDay * Math.PI * 2) * -50;
      const celestialX = 100 + timeOfDay * 800;
      
      if (timeOfDay > 0.25 && timeOfDay < 0.75) {
        // Draw sun during day
        ctx.fillStyle = '#ffdd00';
        ctx.beginPath();
        ctx.arc(celestialX, celestialY, 30, 0, Math.PI * 2);
        ctx.fill();
        
        // Sun glow
        ctx.fillStyle = 'rgba(255, 221, 0, 0.3)';
        ctx.beginPath();
        ctx.arc(celestialX, celestialY, 45, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Draw moon at night
        ctx.fillStyle = '#e0e0e0';
        ctx.beginPath();
        ctx.arc(celestialX, celestialY, 25, 0, Math.PI * 2);
        ctx.fill();
        
        // Moon craters
        ctx.fillStyle = '#c0c0c0';
        ctx.beginPath();
        ctx.arc(celestialX - 8, celestialY - 5, 5, 0, Math.PI * 2);
        ctx.arc(celestialX + 7, celestialY + 3, 4, 0, Math.PI * 2);
        ctx.arc(celestialX - 3, celestialY + 8, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw stars/magical particles (more visible at night)
      const starOpacity = timeOfDay < 0.25 || timeOfDay > 0.75 ? 1 : 0.3;
      ctx.fillStyle = `rgba(255, 255, 170, ${starOpacity})`;
      for (let i = 0; i < 30; i++) {
        const x = (i * 37 + Date.now() * 0.01) % canvas.width;
        const y = (i * 23) % 400;
        ctx.fillRect(x, y, 2, 2);
      }

      // Draw ground
      ctx.fillStyle = '#2d5016';
      ctx.fillRect(0, state.groundY, canvas.width, canvas.height - state.groundY);
      
      // Ground details (grass)
      ctx.fillStyle = '#3d6026';
      for (let i = 0; i < canvas.width; i += 20) {
        ctx.fillRect(i, state.groundY, 10, 5);
      }

      // Draw trees
      state.trees.forEach(tree => {
        if (!tree.chopped) {
          // Flash effect when almost chopped
          const shouldFlash = tree.chops >= 5 && Math.floor(Date.now() / 100) % 2 === 0;
          
          if (!shouldFlash) {
            const treeScale = tree.scale || 1;
            
            // Calculate burn color intensity (green -> orange -> black)
            let trunkColor = '#4a2a1a';
            let foliageColor1, foliageColor2, foliageColor3;
            
            if (tree.onFire) {
              const burnRatio = tree.burnProgress / 100;
              
              if (burnRatio < 0.3) {
                // Early burning - orange/red flames
                const fireIntensity = burnRatio / 0.3;
                foliageColor1 = `rgb(${255}, ${140 * (1 - fireIntensity)}, ${0})`;
                foliageColor2 = `rgb(${255}, ${100 * (1 - fireIntensity)}, ${0})`;
                foliageColor3 = `rgb(${200}, ${80 * (1 - fireIntensity)}, ${0})`;
                trunkColor = `rgb(${74 + 50 * fireIntensity}, ${42 - 20 * fireIntensity}, ${26 - 20 * fireIntensity})`;
              } else if (burnRatio < 0.7) {
                // Mid burning - darkening
                const darkRatio = (burnRatio - 0.3) / 0.4;
                const r = 100 * (1 - darkRatio);
                const g = 50 * (1 - darkRatio);
                foliageColor1 = `rgb(${r}, ${g}, 0)`;
                foliageColor2 = `rgb(${r * 0.8}, ${g * 0.8}, 0)`;
                foliageColor3 = `rgb(${r * 0.6}, ${g * 0.6}, 0)`;
                trunkColor = `rgb(${50 * (1 - darkRatio)}, ${30 * (1 - darkRatio)}, ${20 * (1 - darkRatio)})`;
              } else {
                // Late burning - black
                const blackRatio = (burnRatio - 0.7) / 0.3;
                const c = 30 * (1 - blackRatio);
                foliageColor1 = `rgb(${c}, ${c}, ${c})`;
                foliageColor2 = `rgb(${c * 0.8}, ${c * 0.8}, ${c * 0.8})`;
                foliageColor3 = `rgb(${c * 0.6}, ${c * 0.6}, ${c * 0.6})`;
                trunkColor = `rgb(${c * 0.5}, ${c * 0.5}, ${c * 0.5})`;
              }
            } else {
              // Normal tree colors
              const greenIntensity = Math.max(0, 1 - (tree.chops * 0.15));
              foliageColor1 = `rgb(${26 * greenIntensity}, ${74 * greenIntensity}, ${26 * greenIntensity})`;
              foliageColor2 = `rgb(${42 * greenIntensity}, ${90 * greenIntensity}, ${42 * greenIntensity})`;
              foliageColor3 = `rgb(${58 * greenIntensity}, ${106 * greenIntensity}, ${58 * greenIntensity})`;
            }
            
            // Tree trunk - positioned from ground up
            const trunkWidth = 30 * treeScale;
            const trunkHeight = 70 * treeScale;
            const trunkX = tree.x;
            const trunkY = state.groundY - trunkHeight;
            
            ctx.fillStyle = trunkColor;
            ctx.fillRect(trunkX, trunkY, trunkWidth, trunkHeight);
            
            // Tree foliage (3 layers for depth) - positioned above trunk
            const foliageBaseY = trunkY;
            
            ctx.fillStyle = foliageColor1;
            ctx.beginPath();
            ctx.moveTo(tree.x + 15 * treeScale, foliageBaseY - 80 * treeScale);
            ctx.lineTo(tree.x - 20 * treeScale, foliageBaseY - 20 * treeScale);
            ctx.lineTo(tree.x + 50 * treeScale, foliageBaseY - 20 * treeScale);
            ctx.closePath();
            ctx.fill();
            
            ctx.fillStyle = foliageColor2;
            ctx.beginPath();
            ctx.moveTo(tree.x + 15 * treeScale, foliageBaseY - 50 * treeScale);
            ctx.lineTo(tree.x - 15 * treeScale, foliageBaseY);
            ctx.lineTo(tree.x + 45 * treeScale, foliageBaseY);
            ctx.closePath();
            ctx.fill();
            
            ctx.fillStyle = foliageColor3;
            ctx.beginPath();
            ctx.moveTo(tree.x + 15 * treeScale, foliageBaseY - 30 * treeScale);
            ctx.lineTo(tree.x - 10 * treeScale, foliageBaseY + 20 * treeScale);
            ctx.lineTo(tree.x + 40 * treeScale, foliageBaseY + 20 * treeScale);
            ctx.closePath();
            ctx.fill();
            
            // Fire particles for burning trees
            if (tree.onFire && tree.burnProgress < 70) {
              for (let i = 0; i < 5; i++) {
                const particleX = tree.x + (Math.random() * 40 - 10) * treeScale;
                const particleY = foliageBaseY - Math.random() * 60 * treeScale;
                const size = 2 + Math.random() * 3;
                ctx.fillStyle = Math.random() > 0.5 ? '#ff6600' : '#ffaa00';
                ctx.fillRect(particleX, particleY, size, size);
              }
            }
            
            // Add magical sparkles on healthy trees
            if (!tree.onFire) {
              ctx.fillStyle = '#ffff99';
              ctx.fillRect(tree.x + 10 * treeScale, foliageBaseY - 40 * treeScale, 2, 2);
              ctx.fillRect(tree.x + 25 * treeScale, foliageBaseY - 25 * treeScale, 2, 2);
            }
            
            // Draw apples on apple trees
            if (tree.hasApples && !tree.onFire) {
              ctx.fillStyle = '#ff3333';
              ctx.beginPath();
              ctx.arc(tree.x + 10 * treeScale, foliageBaseY - 30 * treeScale, 4 * treeScale, 0, Math.PI * 2);
              ctx.arc(tree.x + 30 * treeScale, foliageBaseY - 40 * treeScale, 4 * treeScale, 0, Math.PI * 2);
              ctx.arc(tree.x + 20 * treeScale, foliageBaseY - 20 * treeScale, 4 * treeScale, 0, Math.PI * 2);
              ctx.fill();
            }
            
            // Show chop progress
            if (tree.chops > 0 && !tree.onFire) {
              ctx.fillStyle = '#ffffff';
              ctx.font = '14px monospace';
              ctx.fillText(`${tree.chops}/5`, tree.x + 5, foliageBaseY - 90 * treeScale);
            }
          }
        }
      });

      // Handle movement
      if (state.keys['ArrowLeft']) {
        player.x -= player.speed;
      }
      if (state.keys['ArrowRight']) {
        player.x += player.speed;
      }

      // Apply gravity
      player.velocityY += state.gravity;
      player.y += player.velocityY;

      // Ground collision
      if (player.y + player.height >= state.groundY) {
        player.y = state.groundY - player.height;
        player.velocityY = 0;
        player.isGrounded = true;
      } else {
        player.isGrounded = false;
      }

      // Keep player in bounds
      player.x = Math.max(0, Math.min(canvas.width - player.width, player.x));
      
      // Update chop cooldown
      if (state.chopCooldown > 0) {
        state.chopCooldown--;
      }
      if (state.chopCooldown === 0) {
        state.isChopping = false;
      }

      // Draw obstacles
      state.obstacles.forEach(obstacle => {
        if (obstacle.type === 'stump') {
          ctx.fillStyle = '#5a3a1a';
          ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
          ctx.fillStyle = '#4a2a0a';
          ctx.fillRect(obstacle.x + 5, obstacle.y, obstacle.width - 10, 10);
        } else if (obstacle.type === 'rock') {
          ctx.fillStyle = '#6a6a7a';
          ctx.beginPath();
          ctx.moveTo(obstacle.x + obstacle.width / 2, obstacle.y);
          ctx.lineTo(obstacle.x + obstacle.width, obstacle.y + obstacle.height);
          ctx.lineTo(obstacle.x, obstacle.y + obstacle.height);
          ctx.closePath();
          ctx.fill();
        }
      });
      
      // Draw houses
      state.houses.forEach(house => {
        const houseWidth = 80;
        const houseHeight = 60;
        const roofHeight = 30;
        
        // Calculate burn colors
        let wallColor = '#8b6f47';
        let roofColor = '#a0522d';
        let doorColor = '#5a3a1a';
        let windowColor = '#87ceeb';
        
        if (house.onFire) {
          const burnRatio = house.burnProgress / 100;
          
          if (burnRatio < 0.3) {
            // Early burning - orange/red
            const fireIntensity = burnRatio / 0.3;
            wallColor = `rgb(${139 + 116 * fireIntensity}, ${111 - 111 * fireIntensity}, ${71 - 71 * fireIntensity})`;
            roofColor = `rgb(${160 + 95 * fireIntensity}, ${82 - 82 * fireIntensity}, ${45 - 45 * fireIntensity})`;
          } else if (burnRatio < 0.7) {
            // Mid burning - darkening
            const darkRatio = (burnRatio - 0.3) / 0.4;
            const r = 100 * (1 - darkRatio);
            const g = 50 * (1 - darkRatio);
            wallColor = `rgb(${r}, ${g}, 0)`;
            roofColor = `rgb(${r * 0.8}, ${g * 0.8}, 0)`;
          } else {
            // Late burning - black
            const blackRatio = (burnRatio - 0.7) / 0.3;
            const c = 30 * (1 - blackRatio);
            wallColor = `rgb(${c}, ${c}, ${c})`;
            roofColor = `rgb(${c * 0.8}, ${c * 0.8}, ${c * 0.8})`;
          }
          doorColor = wallColor;
          windowColor = `rgb(50, 50, 50)`;
        }
        
        // House walls
        ctx.fillStyle = wallColor;
        ctx.fillRect(house.x, house.y - houseHeight, houseWidth, houseHeight);
        
        // Roof
        ctx.fillStyle = roofColor;
        ctx.beginPath();
        ctx.moveTo(house.x + houseWidth / 2, house.y - houseHeight - roofHeight);
        ctx.lineTo(house.x - 10, house.y - houseHeight);
        ctx.lineTo(house.x + houseWidth + 10, house.y - houseHeight);
        ctx.closePath();
        ctx.fill();
        
        // Door
        ctx.fillStyle = doorColor;
        ctx.fillRect(house.x + 30, house.y - 30, 20, 30);
        
        // Windows
        ctx.fillStyle = windowColor;
        ctx.fillRect(house.x + 15, house.y - 45, 15, 15);
        ctx.fillRect(house.x + 50, house.y - 45, 15, 15);
        
        if (!house.onFire) {
          // Window panes (only show on non-burning houses)
          ctx.strokeStyle = '#5a3a1a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(house.x + 22.5, house.y - 45);
          ctx.lineTo(house.x + 22.5, house.y - 30);
          ctx.moveTo(house.x + 15, house.y - 37.5);
          ctx.lineTo(house.x + 30, house.y - 37.5);
          ctx.moveTo(house.x + 57.5, house.y - 45);
          ctx.lineTo(house.x + 57.5, house.y - 30);
          ctx.moveTo(house.x + 50, house.y - 37.5);
          ctx.lineTo(house.x + 65, house.y - 37.5);
          ctx.stroke();
        }
        
        // Fire particles for burning houses
        if (house.onFire && house.burnProgress < 70) {
          for (let i = 0; i < 8; i++) {
            const particleX = house.x + Math.random() * houseWidth;
            const particleY = house.y - houseHeight - Math.random() * 40;
            const size = 2 + Math.random() * 4;
            ctx.fillStyle = Math.random() > 0.5 ? '#ff6600' : '#ffaa00';
            ctx.fillRect(particleX, particleY, size, size);
          }
        }
      });

      // Draw and check collectibles
      state.collectibles.forEach(item => {
        if (!item || item.collected) return; // Skip if item is invalid or collected
        
        // Check collision with player only
        if (
          player.x < item.x + 20 &&
          player.x + player.width > item.x &&
          player.y < item.y + 20 &&
          player.y + player.height > item.y
        ) {
          item.collected = true;
          const itemType = item.type || 'food'; // Default to food if type is missing
          setScore(prev => ({
            ...prev,
            [itemType]: (prev[itemType] || 0) + 1
          }));
        }

        // Draw collectible
        if (item.type === 'food') {
          // Apple
          ctx.fillStyle = '#ff3333';
          ctx.beginPath();
          ctx.arc(item.x + 10, item.y + 10, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#33aa33';
          ctx.fillRect(item.x + 8, item.y + 2, 4, 6);
        } else if (item.type === 'wood') {
          // Log
          ctx.fillStyle = '#8b5a2b';
          ctx.fillRect(item.x, item.y + 5, 20, 10);
          ctx.fillStyle = '#6b4a1b';
          ctx.fillRect(item.x + 2, item.y + 5, 2, 10);
          ctx.fillRect(item.x + 16, item.y + 5, 2, 10);
        }
      });

      // Draw player (box character with pixel style)
      ctx.fillStyle = '#4a90e2';
      ctx.fillRect(player.x, player.y, player.width, player.height);
      
      // Eyes
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(player.x + 8, player.y + 10, 6, 6);
      ctx.fillRect(player.x + 18, player.y + 10, 6, 6);
      ctx.fillStyle = '#000000';
      ctx.fillRect(player.x + 10, player.y + 12, 3, 3);
      ctx.fillRect(player.x + 20, player.y + 12, 3, 3);
      
      // Chopping animation
      if (state.isChopping && state.chopCooldown > 15) {
        ctx.fillStyle = '#8b5a2b';
        ctx.fillRect(player.x + player.width, player.y + 10, 15, 3);
        ctx.fillRect(player.x + player.width + 12, player.y + 5, 8, 8);
      }
      
      // Draw AI workers
      state.aiWorkers.forEach(worker => {
        // Worker body
        ctx.fillStyle = worker.color;
        ctx.fillRect(worker.x, worker.y, worker.width, worker.height);
        
        // Eyes (closed if sleeping)
        if (worker.state === 'sleeping') {
          // Closed eyes (Z's for sleeping)
          ctx.fillStyle = '#ffffff';
          ctx.font = '12px monospace';
          ctx.fillText('Z', worker.x + worker.width + 5, worker.y + 10);
          ctx.fillText('z', worker.x + worker.width + 12, worker.y + 5);
        } else {
          // Open eyes
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(worker.x + 8, worker.y + 10, 6, 6);
          ctx.fillRect(worker.x + 18, worker.y + 10, 6, 6);
          ctx.fillStyle = '#000000';
          ctx.fillRect(worker.x + 10, worker.y + 12, 3, 3);
          ctx.fillRect(worker.x + 20, worker.y + 12, 3, 3);
        }
        
        // Chopping animation (only when not sleeping)
        if (worker.state === 'chopping' && worker.choppingProgress % 30 < 15) {
          ctx.fillStyle = '#8b5a2b';
          ctx.fillRect(worker.x + worker.width, worker.y + 10, 15, 3);
          ctx.fillRect(worker.x + worker.width + 12, worker.y + 5, 8, 8);
        }
      });

      animationFrameId = requestAnimationFrame(gameLoop);
    };

    gameLoop();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 p-4">
      <div className="mb-4 text-white text-center">
        <h1 className="text-3xl font-bold mb-2 text-purple-300">🌲 Magical Forest 🌲</h1>
        <div className="flex gap-6 justify-center text-xl">
          <span>🍎 Food: {score.food}</span>
          <span>🪵 Wood: {score.wood}</span>
        </div>
        <p className="mt-2 text-sm text-gray-400">Use ← → arrows to move, ↑ or Space to jump, C to chop trees</p>
      </div>
      
      <canvas
        ref={canvasRef}
        width={1000}
        height={500}
        className="border-4 border-purple-500 rounded-lg shadow-2xl"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
};

export default MagicalForestGame;