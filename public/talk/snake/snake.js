class Vector2 {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

class Particle {
    constructor(x, y, velocityX, velocityY, size, color, lifespan) {
        this.x = x;
        this.y = y;
        this.velocityX = velocityX;
        this.velocityY = velocityY;
        this.size = size;
        this.color = color;
        this.lifespan = lifespan;
        this.age = 0;
    }

    update(deltaTime) {
        this.x += this.velocityX * deltaTime * 0.1;
        this.y += this.velocityY * deltaTime * 0.1;
        this.age += deltaTime;
        return this.age < this.lifespan;
    }

    draw(ctx) {
        const alpha = 1 - (this.age / this.lifespan);
        ctx.fillStyle = `rgba(${this.color[0]}, ${this.color[1]}, ${this.color[2]}, ${alpha})`;
        ctx.fillRect(this.x, this.y, this.size, this.size);
    }
}

class FoodItem {
    constructor(position, type, points, color, effect = null) {
        this.position = position;
        this.type = type;
        this.points = points;
        this.color = color;
        this.effect = effect; // Special effect function
        this.spawnTime = Date.now(); // Track when the food was spawned
        this.visible = true; // For blinking effect
        this.blinkRate = 1000; // Initial blink rate in ms (slower)
        this.lastBlink = 0; // Track last blink time
        this.alternateColor = null; // For color alternating effect
        this.lastMove = 0; // Track last move time
    }
}

class SnakeGame {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.restartButton = document.getElementById('restartButton');
        this.speedSlider = document.getElementById('speedSlider');
        this.speedValue = document.getElementById('speedValue');
        this.setupGame();
        this.setupInput();
    }

    setupGame() {
        this.gridSize = 20;
        this.gridWidth = Math.floor(this.canvas.width / this.gridSize);
        this.gridHeight = Math.floor(this.canvas.height / this.gridSize);
        
        // Initialize snake
        this.snake = [new Vector2(5, 5)];
        this.direction = new Vector2(1, 0);
        
        // Initialize food - now we have an array of food items
        this.foodItems = [
            new FoodItem(this.getRandomFoodPosition(), 'apple', 10, '#ff0000'),
            new FoodItem(this.getRandomFoodPosition(), 'apple', 10, '#ff0000')
        ];
        
        // Particle effects
        this.particles = [];
        
        // Screen shake effect
        this.screenShake = {
            active: false,
            duration: 0,
            intensity: 0,
            offsetX: 0,
            offsetY: 0,
            flashActive: false,  // Track if background flash is active
            flashInterval: 50    // Flash every 50ms
        };
        
        // Snake pain effect
        this.snakePain = {
            active: false,
            duration: 0,
            flashInterval: 100, // Flash every 100ms
            flashTimer: 0,
            isRed: false
        };
        
        // Slow motion effect
        this.slowMotion = {
            active: false,
            duration: 0,
            timeScale: 1.0 // Normal speed
        };
        
        // Banana timeout duration (in milliseconds)
        this.bananaTimeout = 8000; // 8 seconds
        
        // Snake color and size effects
        this.snakeColor = '#00ff00'; // Default green
        this.isPinkFromDragonFruit = false;
        this.isWideFromDragonFruit = false; // Track if snake is wide from dragon fruit
        
        // Chance for special fruits to spawn
        this.mangoChance = 1/3;
        this.dragonFruitChance = 0.2;
        this.baseBananaChance = 0.15;
        this.kiwiChance = 0.25;
        this.pineappleChance = 0.2;
        this.blueberryChance = 0.3;
        this.watermelonChance = 0.4; // Increased from 0.25 (25%) to 0.4 (40%)
        
        // Update kiwi movement properties to include vertical movement
        this.kiwiMovement = {
            horizontalDirection: 1,  // 1 for right, -1 for left
            verticalDirection: 1,    // 1 for down, -1 for up
            speed: 1,               // moves 1 grid cell per update
            updateInterval: 500,    // move every 500ms
            moveVertical: false     // toggle between horizontal and vertical movement
        };
        
        // Add striped effect tracking
        this.isStripedFromWatermelon = false;
        
        // Game state
        this.gameOver = false;
        this.score = 0;
        this.speedMultiplier = 1.0; // Base speed multiplier
        
        // Movement cooldown
        this.lastUpdate = 0;
        this.baseInterval = 150; // Fixed base speed (previously controlled by slider)
        this.normalMoveInterval = this.baseInterval; // Initial normal speed
        this.moveInterval = this.normalMoveInterval; // Actual current speed

        // Hide restart button
        this.restartButton.style.display = 'none';
        
        // Start game loop
        this.update();
    }

    setupInput() {
        // Add space bar state tracking
        this.spacebarHeld = false;

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            if (this.gameOver) {
                // Any key press starts a new game when game over
                this.setupGame();
                return;
            }

            if (e.code === 'Space' && !this.spacebarHeld) {
                this.spacebarHeld = true;
                // Slow down the game by 50%
                this.moveInterval = this.normalMoveInterval * 2;
                e.preventDefault(); // Prevent page scrolling
            }

            // Normal movement controls when game is active
            switch(e.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                    if (this.direction.y === 1) {
                        // If going down, first go right then up
                        if (this.direction.x !== -1) { // Ensure we won't hit the left wall
                            this.direction = new Vector2(1, 0);
                            setTimeout(() => {
                                if (!this.gameOver) this.direction = new Vector2(0, -1);
                            }, this.moveInterval);
                        }
                    } else if (this.direction.y !== 1) {
                        this.direction = new Vector2(0, -1);
                    }
                    break;

                case 'ArrowDown':
                case 's':
                case 'S':
                    if (this.direction.y === -1) {
                        // If going up, first go right then down
                        if (this.direction.x !== -1) { // Ensure we won't hit the left wall
                            this.direction = new Vector2(1, 0);
                            setTimeout(() => {
                                if (!this.gameOver) this.direction = new Vector2(0, 1);
                            }, this.moveInterval);
                        }
                    } else if (this.direction.y !== -1) {
                        this.direction = new Vector2(0, 1);
                    }
                    break;

                case 'ArrowLeft':
                case 'a':
                case 'A':
                    if (this.direction.x === 1) {
                        // If going right, first go up then left
                        if (this.direction.y !== 1) { // Ensure we won't hit the bottom wall
                            this.direction = new Vector2(0, -1);
                            setTimeout(() => {
                                if (!this.gameOver) this.direction = new Vector2(-1, 0);
                            }, this.moveInterval);
                        }
                    } else if (this.direction.x !== 1) {
                        this.direction = new Vector2(-1, 0);
                    }
                    break;

                case 'ArrowRight':
                case 'd':
                case 'D':
                    if (this.direction.x === -1) {
                        // If going left, first go up then right
                        if (this.direction.y !== 1) { // Ensure we won't hit the bottom wall
                            this.direction = new Vector2(0, -1);
                            setTimeout(() => {
                                if (!this.gameOver) this.direction = new Vector2(1, 0);
                            }, this.moveInterval);
                        }
                    } else if (this.direction.x !== -1) {
                        this.direction = new Vector2(1, 0);
                    }
                    break;
            }
        });

        // Add keyup handler for spacebar
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.spacebarHeld = false;
                // Return to normal speed if not in slow motion effect
                if (!this.slowMotion.active) {
                    this.moveInterval = this.normalMoveInterval;
                }
            }
        });

        // Restart button
        this.restartButton.addEventListener('click', () => {
            this.setupGame();
        });
    }

    getRandomFoodPosition() {
        let position;
        let isValidPosition = false;
        let attempts = 0;
        const maxAttempts = 100; // Prevent infinite loops
        
        while (!isValidPosition && attempts < maxAttempts) {
            attempts++;
            position = new Vector2(
                Math.floor(Math.random() * this.gridWidth),
                Math.floor(Math.random() * this.gridHeight)
            );
            
            // Check if position overlaps with ANY part of the snake
            let overlapsWithSnake = false;
            for (const segment of this.snake) {
                if (position.x === segment.x && position.y === segment.y) {
                    overlapsWithSnake = true;
                    break;
                }
            }
            
            // Check if position overlaps with other food items
            let overlapsWithFood = false;
            if (this.foodItems) {
                for (const food of this.foodItems) {
                    if (food.position && position.x === food.position.x && position.y === food.position.y) {
                        overlapsWithFood = true;
                        break;
                    }
                }
            }
            
            isValidPosition = !overlapsWithSnake && !overlapsWithFood;
        }
        
        // If we couldn't find a valid position after max attempts, find any position not occupied by snake
        if (!isValidPosition) {
            console.warn("Couldn't find optimal food position after max attempts, using fallback method");
            
            // Create a grid of all available positions
            const availablePositions = [];
            for (let x = 0; x < this.gridWidth; x++) {
                for (let y = 0; y < this.gridHeight; y++) {
                    let isFree = true;
                    
                    // Check if position is occupied by snake
                    for (const segment of this.snake) {
                        if (x === segment.x && y === segment.y) {
                            isFree = false;
                            break;
                        }
                    }
                    
                    if (isFree) {
                        availablePositions.push(new Vector2(x, y));
                    }
                }
            }
            
            // If there are available positions, pick one randomly
            if (availablePositions.length > 0) {
                const randomIndex = Math.floor(Math.random() * availablePositions.length);
                position = availablePositions[randomIndex];
            } else {
                // Game is full, just return a position (game will end soon anyway)
                position = new Vector2(0, 0);
            }
        }
        
        return position;
    }

    startScreenShake(duration, intensity) {
        this.screenShake.active = true;
        this.screenShake.duration = duration;
        this.screenShake.intensity = intensity;
        this.screenShake.offsetX = 0;
        this.screenShake.offsetY = 0;
    }

    startSnakePain(duration) {
        this.snakePain.active = true;
        this.snakePain.duration = duration;
        this.snakePain.flashTimer = 0;
        this.snakePain.isRed = true;
    }

    startSlowMotion(duration, timeScale) {
        this.slowMotion.active = true;
        this.slowMotion.duration = duration;
        this.slowMotion.timeScale = timeScale;
        
        // Apply slow motion to movement speed, accounting for current speed multiplier
        this.moveInterval = this.normalMoveInterval / timeScale;
    }

    updateScreenShake(deltaTime) {
        if (this.screenShake.active) {
            this.screenShake.duration -= deltaTime;
            
            if (this.screenShake.duration <= 0) {
                this.screenShake.active = false;
                this.screenShake.offsetX = 0;
                this.screenShake.offsetY = 0;
                this.screenShake.flashActive = false;
            } else {
                // Calculate random offset based on intensity
                this.screenShake.offsetX = (Math.random() * 2 - 1) * this.screenShake.intensity;
                this.screenShake.offsetY = (Math.random() * 2 - 1) * this.screenShake.intensity;
                
                // Toggle flash state every flashInterval milliseconds
                if (Math.floor(this.screenShake.duration / this.screenShake.flashInterval) % 2 === 0) {
                    this.screenShake.flashActive = true;
                } else {
                    this.screenShake.flashActive = false;
                }
            }
        }
    }

    updateSnakePain(deltaTime) {
        if (this.snakePain.active) {
            this.snakePain.duration -= deltaTime;
            
            if (this.snakePain.duration <= 0) {
                this.snakePain.active = false;
                this.snakePain.isRed = false;
            } else {
                // Update flash timer
                this.snakePain.flashTimer += deltaTime;
                if (this.snakePain.flashTimer >= this.snakePain.flashInterval) {
                    this.snakePain.flashTimer = 0;
                    this.snakePain.isRed = !this.snakePain.isRed; // Toggle red/green
                }
            }
        }
    }

    updateSlowMotion(deltaTime) {
        if (this.slowMotion.active) {
            this.slowMotion.duration -= deltaTime;
            
            if (this.slowMotion.duration <= 0) {
                this.slowMotion.active = false;
                // When slow motion ends, check if spacebar is held
                this.moveInterval = this.spacebarHeld ? 
                    this.normalMoveInterval * 2 : // 50% slower if spacebar held
                    this.normalMoveInterval;      // Normal speed if not
            }
        }
    }

    createExplosion(x, y) {
        // Create red ash explosion effect
        const centerX = x * this.gridSize + this.gridSize / 2;
        const centerY = y * this.gridSize + this.gridSize / 2;
        
        // Create 30 particles for the explosion
        for (let i = 0; i < 30; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3;
            const size = 2 + Math.random() * 3;
            const lifespan = 500 + Math.random() * 1000;
            
            this.particles.push(new Particle(
                centerX,
                centerY,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                size,
                [255, 50 + Math.random() * 50, 50], // Red ash color with variation
                lifespan
            ));
        }
        
        // Start screen shake
        this.startScreenShake(500, 10); // 500ms duration, intensity of 10 pixels
        
        // Start snake pain effect
        this.startSnakePain(1000); // 1 second of pain
        
        // Start slow motion effect - now slower and longer
        this.startSlowMotion(3000, 0.2); // 3 seconds of slow motion at 20% speed
    }

    trySpawnSpecialFruit() {
        // Check if there are any special fruits already
        const hasKiwi = this.foodItems.some(food => food.type === 'kiwi');
        const hasMango = this.foodItems.some(food => food.type === 'mango');
        const hasDragonFruit = this.foodItems.some(food => food.type === 'dragonFruit');
        const hasBanana = this.foodItems.some(food => food.type === 'banana');
        const hasPineapple = this.foodItems.some(food => food.type === 'pineapple');
        const hasBlueberry = this.foodItems.some(food => food.type === 'blueberry');
        const hasWatermelon = this.foodItems.some(food => food.type === 'watermelon');
        
        // Try to spawn watermelon (before banana)
        if (!hasWatermelon && Math.random() < this.watermelonChance) {
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                // Watermelon effect: Makes the snake striped
                const watermelonEffect = () => {
                    this.isStripedFromWatermelon = true;
                    // Reset striped effect after 30 seconds
                    setTimeout(() => {
                        this.isStripedFromWatermelon = false;
                    }, 30000);
                    return false; // No special effect on snake length
                };
                
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'watermelon',
                    50,
                    '#006400', // Dark green color
                    watermelonEffect
                );
                return true;
            }
        }
        
        // Calculate dynamic banana spawn chance based on snake length
        // Increase by 5% for every segment beyond the starting length of 3
        const lengthBonus = Math.max(0, this.snake.length - 3) * 0.05; // 5% per segment
        const bananaChance = Math.min(0.75, this.baseBananaChance + lengthBonus); // Cap at 75%
        
        // Try to spawn kiwi first (new moving fruit)
        if (!hasKiwi && Math.random() < this.kiwiChance) {
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'kiwi',
                    100,  // Changed from 50 to 100 points
                    '#8B4513', // Brown color
                    null // No special effect besides points
                );
                return true;
            }
        }
        
        // Try to spawn pineapple after kiwi but before banana
        if (!hasPineapple && Math.random() < this.pineappleChance) {
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                // Pineapple effect: Makes the snake wear a cowboy hat
                const pineappleEffect = () => {
                    this.snakeHasCowboyHat = true;
                    // Reset hat after 20 seconds (changed from 10 seconds)
                    setTimeout(() => {
                        this.snakeHasCowboyHat = false;
                    }, 20000);
                    return false; // No special effect on snake length
                };
                
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'pineapple',
                    75,
                    '#FFD700', // Golden yellow color
                    pineappleEffect
                );
                return true;
            }
        }
        
        // Try to spawn banana first (most special)
        if (!hasBanana && this.snake.length > 3 && Math.random() < bananaChance) {
            // Find an apple to replace with a banana
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                // Banana effect: remove half of the snake's length, create explosion, and reset speed
                const bananaEffect = (x, y) => {
                    if (this.snake.length > 2) {
                        // Calculate how many segments to remove (half of current length)
                        const segmentsToRemove = Math.floor(this.snake.length / 2);
                        
                        // Remove segments from the end
                        for (let i = 0; i < segmentsToRemove; i++) {
                            this.snake.pop();
                        }
                        
                        // Reset speed to 100%
                        this.speedMultiplier = 1.0;
                        this.normalMoveInterval = this.baseInterval;
                        
                        // If not in slow motion, update the move interval immediately
                        if (!this.slowMotion.active) {
                            this.moveInterval = this.normalMoveInterval;
                        } else {
                            // If in slow motion, maintain the slow motion effect with new base speed
                            this.moveInterval = this.normalMoveInterval / this.slowMotion.timeScale;
                        }
                        
                        // Create explosion at the position of the banana
                        this.createExplosion(x, y);
                        
                        return true; // Effect applied
                    }
                    return false; // No effect (snake too short)
                };
                
                const banana = new FoodItem(
                    this.getRandomFoodPosition(),
                    'banana',
                    60,
                    '#00CED1', // Teal color
                    bananaEffect
                );
                
                // Set alternate color for banana (semi-transparent teal)
                banana.alternateColor = 'rgba(0, 206, 209, 0.25)'; // 25% opacity teal
                banana.spawnTime = Date.now(); // Ensure spawn time is set correctly
                banana.lastBlink = Date.now(); // Initialize last blink time
                
                this.foodItems[appleIndex] = banana;
                
                console.log("Spawned banana at", banana.position.x, banana.position.y, "with spawn time", banana.spawnTime, "and chance", bananaChance.toFixed(2));
                
                return true; // Spawned a banana
            }
        }
        
        // Try to spawn dragon fruit next (high value)
        if (!hasDragonFruit && Math.random() < this.dragonFruitChance) {
            // Find an apple to replace with a dragon fruit
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                // Dragon fruit effect: turn snake pink until next food is eaten
                const dragonFruitEffect = () => {
                    this.isPinkFromDragonFruit = true;
                    // Removed the width change effect
                    return false; // No special effect on snake length
                };
                
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'dragonFruit',
                    50,
                    '#FF69B4', // Pink color
                    dragonFruitEffect
                );
                return true; // Spawned a dragon fruit
            }
        }
        
        // If no special fruit spawned yet, try to spawn a mango
        if (!hasMango && Math.random() < this.mangoChance) {
            // Find an apple to replace with a mango
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'mango',
                    20,
                    '#FFA500' // Orange color
                );
                return true; // Spawned a mango
            }
        }
        
        // Try to spawn blueberry after pineapple but before banana
        if (!hasBlueberry && Math.random() < this.blueberryChance) {
            const appleIndex = this.foodItems.findIndex(food => food.type === 'apple');
            if (appleIndex !== -1) {
                // Blueberry effect: Makes the snake leave a trail of blue particles
                const blueberryEffect = () => {
                    this.leavingBlueTrail = true;
                    // Reset trail effect after 15 seconds
                    setTimeout(() => {
                        this.leavingBlueTrail = false;
                    }, 15000);
                    return false; // No special effect on snake length
                };
                
                this.foodItems[appleIndex] = new FoodItem(
                    this.getRandomFoodPosition(),
                    'blueberry',
                    40, // 40 points
                    '#4169E1', // Royal Blue color
                    blueberryEffect
                );
                return true;
            }
        }
        
        return false; // No special fruit spawned
    }

    updateParticles(deltaTime) {
        // Apply slow motion to particles if active
        const adjustedDelta = this.slowMotion.active ? 
            deltaTime * this.slowMotion.timeScale : deltaTime;
            
        // Update all particles and remove dead ones
        this.particles = this.particles.filter(particle => particle.update(adjustedDelta));
    }

    moveSnake() {
        const head = this.snake[0];
        const newHead = new Vector2(
            head.x + this.direction.x,
            head.y + this.direction.y
        );

        // Check for collisions with walls
        if (newHead.x < 0 || newHead.x >= this.gridWidth ||
            newHead.y < 0 || newHead.y >= this.gridHeight) {
            this.handleGameOver();
            return;
        }

        // Check for collision with self
        for (const segment of this.snake) {
            if (newHead.x === segment.x && newHead.y === segment.y) {
                this.handleGameOver();
                return;
            }
        }

        // Add new head
        this.snake.unshift(newHead);

        // Check if food was eaten
        let foodEaten = false;
        let specialEffect = false;
        
        for (let i = 0; i < this.foodItems.length; i++) {
            const food = this.foodItems[i];
            if (newHead.x === food.position.x && newHead.y === food.position.y) {
                this.score += food.points;
                
                // Apply special effect if any
                if (food.effect) {
                    specialEffect = food.effect(food.position.x, food.position.y);
                }
                
                // Reset pink color and width if the snake was affected by dragon fruit
                // (unless we just ate another dragon fruit)
                if ((this.isPinkFromDragonFruit || this.isWideFromDragonFruit) && food.type !== 'dragonFruit') {
                    this.isPinkFromDragonFruit = false;
                    this.isWideFromDragonFruit = false;
                }
                
                // Increase speed by 5% when food is eaten
                this.speedMultiplier *= 1.05; // 5% increase
                this.normalMoveInterval = this.baseInterval / this.speedMultiplier;
                
                // Only update the actual move interval if not in slow motion
                if (!this.slowMotion.active) {
                    this.moveInterval = this.normalMoveInterval;
                } else {
                    // If in slow motion, maintain the slow motion effect with new base speed
                    this.moveInterval = this.normalMoveInterval / this.slowMotion.timeScale;
                }
                
                // Try to spawn a special fruit when food is eaten
                const spawnedSpecial = this.trySpawnSpecialFruit();
                
                // If no special fruit was spawned, replace with a new apple
                if (!spawnedSpecial) {
                    this.foodItems[i] = new FoodItem(
                        this.getRandomFoodPosition(),
                        'apple',
                        10,
                        '#ff0000'
                    );
                }
                
                foodEaten = true;
                break;
            }
        }

        // Remove tail if no food was eaten or if banana effect was applied
        // (banana already removed segments, so we don't want to remove another)
        if (!foodEaten && !specialEffect) {
            this.snake.pop();
        }
    }

    handleGameOver() {
        this.gameOver = true;
        this.restartButton.style.display = 'block';
    }

    updateFoodItems(currentTime) {
        const now = Date.now();
        
        // Update kiwi position
        for (let i = 0; i < this.foodItems.length; i++) {
            const food = this.foodItems[i];
            if (food.type === 'kiwi') {
                if (now - (food.lastMove || 0) >= this.kiwiMovement.updateInterval) {
                    food.lastMove = now;
                    
                    if (this.kiwiMovement.moveVertical) {
                        // Move kiwi vertically
                        const newY = food.position.y + (this.kiwiMovement.verticalDirection * this.kiwiMovement.speed);
                        
                        // If hitting top or bottom walls, replace with new food
                        if (newY <= 0 || newY >= this.gridHeight - 1) {
                            // Try to spawn a special fruit
                            const spawnedSpecial = this.trySpawnSpecialFruit();
                            
                            // If no special fruit was spawned, replace with a new apple
                            if (!spawnedSpecial) {
                                this.foodItems[i] = new FoodItem(
                                    this.getRandomFoodPosition(),
                                    'apple',
                                    10,
                                    '#ff0000'
                                );
                            }
                        } else {
                            food.position.y = newY;
                        }
                    } else {
                        // Move kiwi horizontally
                        const newX = food.position.x + (this.kiwiMovement.horizontalDirection * this.kiwiMovement.speed);
                        
                        // If hitting side walls, replace with new food
                        if (newX <= 0 || newX >= this.gridWidth - 1) {
                            // Try to spawn a special fruit
                            const spawnedSpecial = this.trySpawnSpecialFruit();
                            
                            // If no special fruit was spawned, replace with a new apple
                            if (!spawnedSpecial) {
                                this.foodItems[i] = new FoodItem(
                                    this.getRandomFoodPosition(),
                                    'apple',
                                    10,
                                    '#ff0000'
                                );
                            }
                        } else {
                            food.position.x = newX;
                        }
                    }
                }
            }
            
            // Check for banana timeout
            if (food.type === 'banana') {
                const elapsedTime = now - food.spawnTime;
                
                // Check if banana should disappear
                if (elapsedTime >= this.bananaTimeout) {
                    console.log("Banana timed out after", elapsedTime, "ms");
                    // Replace with a new apple
                    this.foodItems[i] = new FoodItem(
                        this.getRandomFoodPosition(),
                        'apple',
                        10,
                        '#ff0000'
                    );
                    continue;
                }
                
                // Calculate blink rate based on elapsed time
                // Start at 1000ms (1 sec) and decrease to 100ms (0.1 sec) over the timeout period
                const blinkProgress = elapsedTime / this.bananaTimeout; // 0 to 1
                food.blinkRate = 1000 - (blinkProgress * 900); // 1000ms to 100ms
                
                // Update blinking state
                if (now - food.lastBlink >= food.blinkRate) {
                    food.visible = !food.visible;
                    food.lastBlink = now;
                    console.log("Banana blink state:", food.visible, "at rate:", food.blinkRate);
                }
            }
        }
    }

    update(currentTime = 0) {
        const deltaTime = currentTime - this.lastUpdate;

        if (!this.gameOver) {
            // Add blue trail particles if effect is active
            if (this.leavingBlueTrail && this.snake.length > 0) {
                const head = this.snake[0];
                // Create a particle at the snake's position
                this.particles.push(new Particle(
                    head.x * this.gridSize + this.gridSize/2,
                    head.y * this.gridSize + this.gridSize/2,
                    (Math.random() - 0.5) * 0.5, // Slight random horizontal movement
                    (Math.random() - 0.5) * 0.5, // Slight random vertical movement
                    3, // Size
                    [65, 105, 225], // Blue color
                    1000 // Lifespan in milliseconds
                ));
            }
            
            // Move snake based on interval
            if (deltaTime >= this.moveInterval) {
                this.lastUpdate = currentTime;
                this.moveSnake();
            }
            
            // Update food items (for blinking bananas) - call on every frame
            this.updateFoodItems(currentTime);
        }

        // Update particles regardless of game state
        this.updateParticles(deltaTime);
        
        // Update screen shake
        this.updateScreenShake(deltaTime);
        
        // Update snake pain effect
        this.updateSnakePain(deltaTime);
        
        // Update slow motion effect
        this.updateSlowMotion(deltaTime);

        this.draw();
        requestAnimationFrame((time) => this.update(time));
    }

    draw() {
        // Clear the canvas with flash effect if active
        if (this.screenShake.active && this.screenShake.flashActive) {
            this.ctx.fillStyle = '#ffffff'; // White flash
        } else {
            this.ctx.fillStyle = '#000000'; // Normal black background
        }
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Apply screen shake
        this.ctx.save();
        if (this.screenShake.active) {
            this.ctx.translate(this.screenShake.offsetX, this.screenShake.offsetY);
        }

        // Draw snake segments
        for (let i = 0; i < this.snake.length; i++) {
            const segment = this.snake[i];
            
            // Determine snake color based on effects
            if (this.snakePain.active && this.snakePain.isRed) {
                this.ctx.fillStyle = '#ff3333'; // Bright red for pain
            } else if (this.isPinkFromDragonFruit) {
                this.ctx.fillStyle = '#FF69B4'; // Pink from dragon fruit
            } else if (this.isStripedFromWatermelon) {
                // Draw each segment with both colors, split horizontally
                const x = segment.x * this.gridSize;
                const y = segment.y * this.gridSize;
                const width = this.gridSize - 1;
                const height = this.gridSize - 1;
                
                // Draw pink top half
                this.ctx.fillStyle = '#FF69B4';
                this.ctx.fillRect(x, y, width, height/2);
                
                // Draw green bottom half
                this.ctx.fillStyle = '#228B22';
                this.ctx.fillRect(x, y + height/2, width, height/2);
            } else {
                this.ctx.fillStyle = '#00ff00'; // Normal green
            }
            
            // Only draw the full segment if not striped from watermelon
            if (!this.isStripedFromWatermelon) {
                this.ctx.fillRect(
                    segment.x * this.gridSize,
                    segment.y * this.gridSize,
                    this.gridSize - 1,
                    this.gridSize - 1
                );
            }
            
            // Draw cowboy hat on snake head if effect is active
            if (this.snakeHasCowboyHat && segment === this.snake[0]) {
                this.ctx.fillStyle = '#8B4513'; // Brown color for hat
                // Draw hat brim
                this.ctx.fillRect(
                    segment.x * this.gridSize - 4,
                    segment.y * this.gridSize - 4,
                    this.gridSize + 8,
                    3
                );
                // Draw hat top
                this.ctx.fillRect(
                    segment.x * this.gridSize,
                    segment.y * this.gridSize - 8,
                    this.gridSize - 1,
                    5
                );
            }
        }

        // Draw food items
        for (const food of this.foodItems) {
            // First draw the food item itself
            if (food.type === 'banana') {
                // Choose color based on visibility state
                this.ctx.fillStyle = food.visible ? food.color : (food.alternateColor || 'rgba(0, 206, 209, 0.25)');
                
                // Draw the banana (or its blinking state)
                this.ctx.fillRect(
                    food.position.x * this.gridSize,
                    food.position.y * this.gridSize,
                    this.gridSize - 1,
                    this.gridSize - 1
                );
                
                // Debug: Show elapsed time (only if debug mode is on)
                if (false && food.visible) { // Set to true to enable debug timer
                    const elapsedTime = Math.floor((Date.now() - food.spawnTime) / 1000);
                    const remainingTime = Math.max(0, Math.floor(this.bananaTimeout / 1000) - elapsedTime);
                    
                    this.ctx.fillStyle = 'white';
                    this.ctx.font = '10px Arial';
                    this.ctx.fillText(
                        remainingTime + 's', 
                        food.position.x * this.gridSize, 
                        (food.position.y * this.gridSize) - 2
                    );
                }
            } else {
                // Regular food items
                this.ctx.fillStyle = food.color;
                this.ctx.fillRect(
                    food.position.x * this.gridSize,
                    food.position.y * this.gridSize,
                    this.gridSize - 1,
                    this.gridSize - 1
                );
                
                // Add cowboy hats to pineapple and watermelon
                if (food.type === 'pineapple' || food.type === 'watermelon') {
                    this.ctx.fillStyle = '#8B4513'; // Brown color for hat
                    // Draw hat brim
                    this.ctx.fillRect(
                        food.position.x * this.gridSize - 2,
                        food.position.y * this.gridSize - 2,
                        this.gridSize + 4,
                        2
                    );
                    // Draw hat top
                    this.ctx.fillRect(
                        food.position.x * this.gridSize + 2,
                        food.position.y * this.gridSize - 5,
                        this.gridSize - 5,
                        4
                    );
                }
            }
        }
        
        // Draw particles
        for (const particle of this.particles) {
            particle.draw(this.ctx);
        }
        
        // Restore context (end screen shake)
        this.ctx.restore();

        // Draw score (not affected by screen shake)
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '20px Arial';
        this.ctx.fillText(`Score: ${this.score}`, 10, 30);
        
        // Display current speed multiplier
        const speedPercentage = Math.round((this.speedMultiplier - 1) * 100);
        if (speedPercentage > 0) {
            this.ctx.fillStyle = '#ffcc00';
            this.ctx.font = '16px Arial';
            this.ctx.fillText(`Speed: +${speedPercentage}%`, 10, 55);
        }
        
        // Draw game over message (not affected by screen shake)
        if (this.gameOver) {
            this.ctx.fillStyle = '#ffffff';
            this.ctx.font = '40px Arial';
            this.ctx.fillText('Game Over!', 
                this.canvas.width / 2 - 100, 
                this.canvas.height / 2
            );
        }
    }
}

// Start the game when the page loads
window.onload = () => {
    new SnakeGame();
}; 