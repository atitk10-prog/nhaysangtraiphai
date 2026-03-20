import React, { useState, useEffect, useRef } from 'react';
import { FaceMesh } from '@mediapipe/face_mesh';
import * as cam from '@mediapipe/camera_utils';
import confetti from 'canvas-confetti';
import { Brain, Camera, CheckCircle2, Play, Plus, Save, Trash2, User, Video, XCircle, Download, Upload, Settings, Timer, Sliders, ArrowLeft, ArrowRight, ImagePlus, X, Volume2, Users, Move, Hand, Mic } from 'lucide-react';
import { generateQuestions, Question } from './services/gemini';

// --- Types ---
type GameState = 'TEACHER' | 'READY' | 'PLAYING' | 'FINISHED';
type GameMode = 'TILT' | 'JUMP' | 'GROUP' | 'CLAP' | 'HANDS';

export default function App() {

  const [gameState, setGameState] = useState<GameState>('TEACHER');
  const [questions, setQuestions] = useState<Question[]>(() => {
    const saved = localStorage.getItem('tilt-quiz-questions');
    return saved ? JSON.parse(saved) : [];
  });
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [userAnswers, setUserAnswers] = useState<('A' | 'B' | 'TIMEOUT' | null)[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [topic, setTopic] = useState('');
  const [questionCount, setQuestionCount] = useState(5);
  const [facePosition, setFacePosition] = useState(0.5); // 0.0 (left in raw) → 1.0 (right in raw)
  const [selection, setSelection] = useState<'A' | 'B' | null>(null);
  const [selectionProgress, setSelectionProgress] = useState(0);
  const [feedback, setFeedback] = useState<'CORRECT' | 'WRONG' | 'TIMEOUT' | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [faceDetected, setFaceDetected] = useState(false);
  
  // Zone thresholds (normalized 0-1 in raw camera coords)
  const ZONE_LEFT = 0.35;  // faceX < 0.35 → right side on screen (mirror) → B
  const ZONE_RIGHT = 0.65; // faceX > 0.65 → left side on screen (mirror) → A
  const CONFIRM_TIME = 1500; // 1.5 seconds to confirm
  const [timeLimit, setTimeLimit] = useState(10);
  const [timeLeft, setTimeLeft] = useState(10);
  const [showSettings, setShowSettings] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>('JUMP');
  
  // Sound settings
  const [sfxVolume, setSfxVolume] = useState(0.5);
  const [bgmVolume, setBgmVolume] = useState(0.2);
  const [bgmBuffer, setBgmBuffer] = useState<AudioBuffer | null>(null);
  const [bgmUrl, setBgmUrl] = useState(''); // just for UI display
  const bgmSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bgmGainRef = useRef<GainNode | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null); // keep for compatibility

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionStartTime = useRef<number | null>(null);
  const lastTilt = useRef<'A' | 'B' | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Clap detection refs
  const [clapCount, setClapCount] = useState(0);
  const clapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const clapCooldownRef = useRef(false);

  // Hands detection
  const [handsCount, setHandsCount] = useState(0);

  // Helper for dynamic font size
  const getFontSize = (text: string) => {
    if (text.length > 100) return 'text-sm';
    if (text.length > 80) return 'text-base';
    if (text.length > 60) return 'text-lg';
    if (text.length > 40) return 'text-xl';
    if (text.length > 25) return 'text-2xl';
    if (text.length > 15) return 'text-3xl';
    return 'text-4xl md:text-5xl';
  };

  // Sound helper using Web Audio API (guaranteed to work)
  const playSfx = (type: 'correct' | 'wrong' | 'timeout' | 'start' | 'next' | 'celebrate' | 'select') => {
    // Suppress clap detection so mic doesn't pick up our own sounds
    if (gameMode === 'CLAP') {
      clapCooldownRef.current = true;
      setTimeout(() => { clapCooldownRef.current = false; }, 1500);
    }
    try {
      const ctx = new AudioContext();
      const vol = ctx.createGain();
      vol.connect(ctx.destination);
      vol.gain.value = sfxVolume * 0.3;
      const now = ctx.currentTime;

      const playTone = (freq: number, start: number, dur: number, waveType: OscillatorType = 'sine') => {
        const osc = ctx.createOscillator();
        osc.type = waveType;
        osc.frequency.value = freq;
        osc.connect(vol);
        osc.start(now + start);
        osc.stop(now + start + dur);
      };

      if (type === 'correct') {
        vol.gain.value = sfxVolume * 0.4;
        playTone(523, 0, 0.15); playTone(659, 0.12, 0.15); playTone(784, 0.24, 0.15); playTone(1047, 0.36, 0.3);
      } else if (type === 'wrong') {
        vol.gain.value = sfxVolume * 0.3;
        playTone(400, 0, 0.2, 'sawtooth'); playTone(300, 0.2, 0.2, 'sawtooth'); playTone(200, 0.4, 0.3, 'sawtooth');
      } else if (type === 'timeout') {
        vol.gain.value = sfxVolume * 0.5;
        playTone(440, 0, 0.2, 'square'); playTone(330, 0.25, 0.2, 'square'); playTone(440, 0.5, 0.2, 'square'); playTone(330, 0.75, 0.3, 'square');
      } else if (type === 'start') {
        vol.gain.value = sfxVolume * 0.35;
        playTone(392, 0, 0.15); playTone(392, 0.15, 0.15); playTone(392, 0.3, 0.15); playTone(523, 0.45, 0.4);
      } else if (type === 'next') {
        playTone(880, 0, 0.1); playTone(1100, 0.08, 0.12);
      } else if (type === 'celebrate') {
        vol.gain.value = sfxVolume * 0.4;
        playTone(523, 0, 0.15); playTone(659, 0.15, 0.15); playTone(784, 0.3, 0.15);
        playTone(1047, 0.45, 0.2); playTone(784, 0.65, 0.1); playTone(1047, 0.75, 0.4);
      } else if (type === 'select') {
        vol.gain.value = sfxVolume * 0.15;
        playTone(600, 0, 0.05); playTone(800, 0.04, 0.06);
      }

      setTimeout(() => ctx.close().catch(() => {}), 2000);
    } catch {}
  };

  // BGM: play/stop using AudioContext (same as SFX)
  const stopBgm = () => {
    if (bgmSourceRef.current) {
      try { bgmSourceRef.current.stop(); } catch {}
      bgmSourceRef.current = null;
    }
  };

  useEffect(() => {
    // Only play when PLAYING + has buffer
    if (gameState !== 'PLAYING' || !bgmBuffer) {
      stopBgm();
      return;
    }
    
    // Create AudioContext if needed
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Create gain node for volume
    const gainNode = ctx.createGain();
    gainNode.gain.value = bgmVolume;
    gainNode.connect(ctx.destination);
    bgmGainRef.current = gainNode;
    
    // Create source and play
    const source = ctx.createBufferSource();
    source.buffer = bgmBuffer;
    source.loop = true;
    source.connect(gainNode);
    source.start(0);
    bgmSourceRef.current = source;
    console.log('BGM: playing via AudioContext!');
    
    return () => {
      try { source.stop(); } catch {}
      bgmSourceRef.current = null;
      bgmGainRef.current = null;
      ctx.close();
    };
  }, [gameState, bgmBuffer]);

  // BGM: volume control
  useEffect(() => {
    if (bgmGainRef.current) bgmGainRef.current.gain.value = bgmVolume;
  }, [bgmVolume]);

  // Save questions to localStorage
  useEffect(() => {
    localStorage.setItem('tilt-quiz-questions', JSON.stringify(questions));
  }, [questions]);

  // Timer logic
  useEffect(() => {
    if (gameState === 'PLAYING' && !feedback) {
      if (timeLeft > 0) {
        timerRef.current = setTimeout(() => {
          setTimeLeft(prev => prev - 1);
          // Play tick sound for last 3 seconds
          if (timeLeft <= 3) {
            playSfx('select');
          }
        }, 1000);
      } else {
        handleTimeout();
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [gameState, timeLeft, feedback]);

  const handleTimeout = () => {
    setFeedback('TIMEOUT');
    const newAnswers = [...userAnswers];
    newAnswers[currentQuestionIndex] = 'TIMEOUT';
    setUserAnswers(newAnswers);
    // In GROUP mode, highlight the correct answer
    if (gameMode === 'GROUP') {
      setSelection(questions[currentQuestionIndex].correct);
    }
    playSfx('timeout');
    setTimeout(nextQuestion, 3000);
  };

  // --- AI Generation ---
  const handleGenerate = async () => {
    if (!topic.trim()) return;
    setIsGenerating(true);
    try {
      const newQuestions = await generateQuestions(topic, questionCount);
      setQuestions(newQuestions);
    } catch (error) {
      alert('Lỗi khi tạo câu hỏi. Vui lòng thử lại.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddQuestion = () => {
    setQuestions([...questions, { question: 'Câu hỏi mới?', A: 'Đáp án A', B: 'Đáp án B', correct: 'A' }]);
  };

  // --- Image Upload Handler ---
  const handleImageUpload = (index: number, field: 'questionImage' | 'imageA' | 'imageB') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        alert('Ảnh quá lớn! Vui lòng chọn ảnh dưới 5MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        handleUpdateQuestion(index, { ...questions[index], [field]: dataUrl });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const handleRemoveImage = (index: number, field: 'questionImage' | 'imageA' | 'imageB') => {
    const updated = { ...questions[index] };
    delete (updated as any)[field];
    handleUpdateQuestion(index, updated);
  };

  const handleDeleteQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const handleUpdateQuestion = (index: number, updated: Question) => {
    const newQs = [...questions];
    newQs[index] = updated;
    setQuestions(newQs);
  };

  // --- Export/Import ---
  const handleExport = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(questions));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "tilt-quiz.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        if (Array.isArray(imported)) {
          setQuestions(imported);
          alert('Nhập câu hỏi thành công!');
        }
      } catch (err) {
        alert('Lỗi khi nhập file JSON.');
      }
    };
    reader.readAsText(file);
  };

  // --- BGM Upload ---
  const handleBgmUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        // Read file as ArrayBuffer and decode to AudioBuffer
        const arrayBuffer = await file.arrayBuffer();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        ctx.close();
        setBgmBuffer(audioBuffer);
        setBgmUrl(file.name); // just for UI display
        alert('✅ Đã tải nhạc nền: ' + file.name);
      } catch (err) {
        alert('❌ Không thể đọc file nhạc. Thử file mp3 khác.');
        console.error('BGM decode error:', err);
      }
    };
    input.click();
  };

  // --- Game Logic ---
  const startGame = () => {
    if (questions.length === 0) {
      alert('Vui lòng tạo câu hỏi trước!');
      return;
    }
    setGameState('READY');
  };

  const nextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
      setFeedback(null);
      setSelection(null);
      setSelectionProgress(0);
      selectionStartTime.current = null;
      setTimeLeft(timeLimit);
      
      playSfx('next');
    } else {
      setGameState('FINISHED');
      // Cheering / celebration sound
      playSfx('celebrate');
      confetti({ particleCount: 200, spread: 100, origin: { y: 0.6 } });
    }
  };

  const checkAnswer = (choice: 'A' | 'B') => {
    const correct = questions[currentQuestionIndex].correct === choice;
    const newAnswers = [...userAnswers];
    newAnswers[currentQuestionIndex] = choice;
    setUserAnswers(newAnswers);

    if (correct) {
      setScore(prev => prev + 1);
      setFeedback('CORRECT');
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      playSfx('correct');
    } else {
      setFeedback('WRONG');
      playSfx('wrong');
    }

    setTimeout(nextQuestion, 3000);
  };

  // --- MediaPipe Tracking ---
  useEffect(() => {
    if (gameState !== 'PLAYING' || (gameMode !== 'JUMP' && gameMode !== 'TILT') || !videoRef.current) return;

    let isClosed = false;

    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults((results) => {
      if (isClosed) return;
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        setFaceDetected(true);
        
        // Use nose tip (landmark 1) X position to detect zone
        const noseTip = landmarks[1];
        const faceX = noseTip.x;
        setFacePosition(faceX);

        if (feedback) return;

        let currentZone: 'A' | 'B' | null = null;

        if (gameMode === 'TILT') {
          // TILT MODE: use head tilt angle
          const leftEye = landmarks[33];
          const rightEye = landmarks[263];
          const dy = rightEye.y - leftEye.y;
          const dx = rightEye.x - leftEye.x;
          const angle = Math.atan2(dy, dx) * (180 / Math.PI);
          if (angle > 15) currentZone = 'A';
          else if (angle < -15) currentZone = 'B';
        } else {
          // JUMP MODE: use face X position with zones
          if (faceX > ZONE_RIGHT) currentZone = 'A';
          else if (faceX < ZONE_LEFT) currentZone = 'B';
        }

        if (currentZone !== lastTilt.current) {
          lastTilt.current = currentZone;
          selectionStartTime.current = currentZone ? Date.now() : null;
          setSelection(currentZone);
          setSelectionProgress(0);

          if (currentZone) {
            playSfx('select');
          }
        } else if (currentZone && selectionStartTime.current) {
          const elapsed = Date.now() - selectionStartTime.current;
          const progress = Math.min(elapsed / CONFIRM_TIME, 1);
          setSelectionProgress(progress);
          
          if (progress === 1) {
            checkAnswer(currentZone);
            selectionStartTime.current = null;
          }
        }
      } else {
        setFaceDetected(false);
        setSelection(null);
        setSelectionProgress(0);
        selectionStartTime.current = null;
      }
    });

    const camera = new cam.Camera(videoRef.current, {
      onFrame: async () => {
        if (isClosed || !videoRef.current) return;
        try {
          await faceMesh.send({ image: videoRef.current });
        } catch (e) {
          if (!isClosed) {
            console.error("FaceMesh processing error:", e);
          }
        }
      },
      // Removing fixed width/height to let browser choose best fit if 640x480 fails
    });

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setCameraError("Trình duyệt của bạn không hỗ trợ truy cập Camera.");
          return;
        }
        await camera.start();
      } catch (err: any) {
        if (isClosed) return;
        console.error("Camera start error:", err);
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setCameraError("Không tìm thấy thiết bị Camera nào. Vui lòng kết nối Camera.");
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setCameraError("Quyền truy cập Camera bị từ chối. Vui lòng cấp quyền trong cài đặt trình duyệt.");
        } else {
          setCameraError(`Lỗi Camera: ${err.message || "Không thể khởi động camera"}`);
        }
      }
    };

    startCamera();

    return () => {
      isClosed = true;
      try {
        camera.stop();
      } catch (e) {
        console.error("Error stopping camera:", e);
      }
      faceMesh.close();
    };
  }, [gameState, feedback]);

  // --- Clap Detection (CLAP mode) ---
  const [micLevel, setMicLevel] = useState(0);

  useEffect(() => {
    if (gameState !== 'PLAYING' || gameMode !== 'CLAP') return;
    let stopped = false;
    let animFrameId: number;
    let localClapCount = 0;
    let lastClapTime = 0;

    const startClap = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.fftSize);

        const detect = () => {
          if (stopped) return;
          analyser.getByteTimeDomainData(data);
          
          // Calculate RMS energy (more reliable than peak)
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          const level = Math.min(rms * 5, 1); // Normalize 0-1
          setMicLevel(level);

          const now = Date.now();
          // Clap threshold: RMS > 0.15 (fairly sensitive) and not in cooldown
          if (rms > 0.15 && !clapCooldownRef.current && (now - lastClapTime) > 150) {
            clapCooldownRef.current = true;
            lastClapTime = now;
            localClapCount++;
            setClapCount(localClapCount);
            
            // Short cooldown: 150ms (allows fast double-clap)
            setTimeout(() => { clapCooldownRef.current = false; }, 150);
            
            // Decision window: 2s after first clap
            if (clapTimeoutRef.current) clearTimeout(clapTimeoutRef.current);
            clapTimeoutRef.current = setTimeout(() => {
              if (localClapCount === 1) {
                setSelection('A');
                selectionStartTime.current = Date.now();
              } else if (localClapCount >= 2) {
                setSelection('B');
                selectionStartTime.current = Date.now();
              }
              localClapCount = 0;
              setClapCount(0);
            }, 2000);
          }
          animFrameId = requestAnimationFrame(detect);
        };
        detect();
      } catch (err) {
        console.error('Mic error:', err);
        setCameraError('Không thể truy cập Microphone. Vui lòng cấp quyền.');
      }
    };
    startClap();

    return () => {
      stopped = true;
      cancelAnimationFrame(animFrameId);
      if (clapTimeoutRef.current) clearTimeout(clapTimeoutRef.current);
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
    };
  }, [gameState, gameMode]);

  // Clap mode: confirm selection after 2s
  useEffect(() => {
    if (gameState !== 'PLAYING' || gameMode !== 'CLAP' || !selection || feedback) return;
    const interval = setInterval(() => {
      if (selectionStartTime.current) {
        const elapsed = Date.now() - selectionStartTime.current;
        const progress = Math.min(elapsed / CONFIRM_TIME, 1);
        setSelectionProgress(progress);
        if (progress === 1) {
          checkAnswer(selection);
          selectionStartTime.current = null;
          setSelection(null);
          setSelectionProgress(0);
        }
      }
    }, 50);
    return () => clearInterval(interval);
  }, [gameState, gameMode, selection, feedback]);

  // --- Hands Detection (HANDS mode) ---
  useEffect(() => {
    if (gameState !== 'PLAYING' || gameMode !== 'HANDS' || !videoRef.current) return;
    let stopped = false;
    let handsInstance: any = null;

    const startHandsDetection = () => {
      // Start camera for hands mode
      navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 640 }, height: { ideal: 480 } } 
      }).then(stream => {
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.onloadeddata = () => {
          // Camera is ready, now load MediaPipe Hands
          loadHandsModel();
        };
        videoRef.current.play().catch(() => {});
      }).catch(() => {
        setCameraError('Không thể truy cập Camera cho chế độ giơ tay.');
      });
    };

    const loadHandsModel = () => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
      script.onload = () => {
        const HandsClass = (window as any).Hands;
        if (!HandsClass || stopped) return;
        
        handsInstance = new HandsClass({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        handsInstance.setOptions({
          maxNumHands: 1,           // Only need 1 hand for finger counting
          modelComplexity: 1,
          minDetectionConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
        handsInstance.onResults((results: any) => {
          if (stopped || feedback) return;
          
          // Count raised fingers across all detected hands
          let totalFingers = 0;
          const hands = results.multiHandLandmarks || [];
          for (const landmarks of hands) {
            // Use MCP (knuckle base) as reference instead of PIP for more reliable detection
            // Finger: [tip, MCP] — tip must be SIGNIFICANTLY above MCP to count
            // Index: tip=8, MCP=5 | Middle: tip=12, MCP=9 | Ring: tip=16, MCP=13 | Pinky: tip=20, MCP=17
            const fingerPairs = [[8, 5], [12, 9], [16, 13], [20, 17]];
            for (const [tip, mcp] of fingerPairs) {
              // Tip must be at least 0.06 above MCP (prevents half-curled false positives)
              if (landmarks[mcp].y - landmarks[tip].y > 0.06) {
                totalFingers++;
              }
            }
            // Thumb excluded — natural position causes false positives
          }
          
          setHandsCount(totalFingers);
          let zone: 'A' | 'B' | null = null;
          if (totalFingers === 1) zone = 'A';
          else if (totalFingers >= 2) zone = 'B';

          if (zone !== lastTilt.current) {
            lastTilt.current = zone;
            selectionStartTime.current = zone ? Date.now() : null;
            setSelection(zone);
            setSelectionProgress(0);
          } else if (zone && selectionStartTime.current) {
            const elapsed = Date.now() - selectionStartTime.current;
            const progress = Math.min(elapsed / CONFIRM_TIME, 1);
            setSelectionProgress(progress);
            if (progress === 1) {
              checkAnswer(zone);
              selectionStartTime.current = null;
            }
          }
        });

        const processFrame = async () => {
          if (stopped || !videoRef.current || videoRef.current.readyState < 2) {
            if (!stopped) requestAnimationFrame(processFrame);
            return;
          }
          try {
            await handsInstance.send({ image: videoRef.current });
          } catch {}
          if (!stopped) requestAnimationFrame(processFrame);
        };
        processFrame();
      };
      document.head.appendChild(script);
    };

    startHandsDetection();
    return () => {
      stopped = true;
      if (handsInstance) { try { handsInstance.close(); } catch {} }
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
    };
  }, [gameState, gameMode, feedback]);

  // --- Start actually playing (from READY screen) ---
  const beginPlaying = () => {
    setGameState('PLAYING');
    setCurrentQuestionIndex(0);
    setScore(0);
    setUserAnswers(new Array(questions.length).fill(null));
    setFeedback(null);
    setSelection(null);
    setSelectionProgress(0);
    setClapCount(0);
    setHandsCount(0);
    setTimeLeft(timeLimit);
    setCameraError(null);
    playSfx('start');
  };

  return (
    <div className={`min-h-screen transition-colors duration-500 ${feedback === 'CORRECT' ? 'bg-emerald-50' : feedback === 'WRONG' ? 'bg-red-50' : 'bg-[#FDFCFB]'} text-[#1D1D1F] font-sans selection:bg-emerald-100`}>
      {/* Header */}
      <header className="border-b border-black/5 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
              <Brain size={24} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">AI Head Tilt Quiz</h1>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 text-gray-500 hover:text-indigo-600 transition-colors"
              title="Cài đặt"
            >
              <Settings size={20} />
            </button>
            {gameState !== 'TEACHER' && (
              <button 
                onClick={() => setGameState('TEACHER')}
                className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors"
              >
                Thoát trò chơi
              </button>
            )}
          </div>
        </div>
      </header>

      {showSettings && (
        <div className="bg-white border-b border-black/5 animate-in slide-in-from-top duration-300">
          <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center gap-8">
            <div className="flex items-center gap-3">
              <Timer size={18} className="text-gray-400" />
              <label className="text-sm font-medium text-gray-600">Thời gian ({timeLimit}s)</label>
              <input 
                type="range" min="5" max="60" value={timeLimit} 
                onChange={(e) => setTimeLimit(parseInt(e.target.value))}
                className="accent-indigo-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <Volume2 size={18} className="text-gray-400" />
              <label className="text-sm font-medium text-gray-600">SFX ({Math.round(sfxVolume * 100)}%)</label>
              <input 
                type="range" min="0" max="100" value={sfxVolume * 100}
                onChange={(e) => setSfxVolume(parseInt(e.target.value) / 100)}
                className="accent-emerald-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <Volume2 size={18} className="text-gray-400" />
              <label className="text-sm font-medium text-gray-600">Nhạc nền ({Math.round(bgmVolume * 100)}%)</label>
              <input 
                type="range" min="0" max="100" value={bgmVolume * 100}
                onChange={(e) => setBgmVolume(parseInt(e.target.value) / 100)}
                className="accent-amber-500"
              />
              <button onClick={handleBgmUpload} className="text-xs px-3 py-1 bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200 transition-colors font-medium">
                {bgmUrl ? '🎵 Đã chọn' : 'Tải nhạc'}
              </button>
              {bgmUrl && <button onClick={() => setBgmUrl('')} className="text-xs text-red-400 hover:text-red-600">Xóa</button>}
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8">
        {gameState === 'TEACHER' && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* Generation Section */}
            <section className="bg-white rounded-3xl p-8 border border-black/5 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-8 bg-emerald-500 rounded-full" />
                  <h2 className="text-2xl font-semibold italic serif">Tạo câu hỏi với AI</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={handleExport}
                    className="p-2 text-gray-500 hover:text-emerald-600 transition-colors flex items-center gap-2 text-sm font-medium"
                    title="Tải về bộ câu hỏi"
                  >
                    <Download size={18} />
                    Xuất JSON
                  </button>
                  <label className="p-2 text-gray-500 hover:text-indigo-600 transition-colors flex items-center gap-2 text-sm font-medium cursor-pointer">
                    <Upload size={18} />
                    Nhập JSON
                    <input type="file" accept=".json" onChange={handleImport} className="hidden" />
                  </label>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="md:col-span-3">
                    <label className="block text-sm font-medium text-gray-500 mb-2 uppercase tracking-wider">Chủ đề hoặc Nội dung bài học</label>
                    <textarea 
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="Ví dụ: Lịch sử nhà Trần, Các hành tinh trong hệ mặt trời..."
                      className="w-full h-32 p-4 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all outline-none resize-none"
                    />
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-sm font-medium text-gray-500 mb-2 uppercase tracking-wider">Số câu hỏi</label>
                    <input 
                      type="number"
                      min="1"
                      max="20"
                      value={questionCount}
                      onChange={(e) => setQuestionCount(parseInt(e.target.value) || 1)}
                      className="w-full p-4 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all outline-none"
                    />
                    <p className="text-xs text-gray-400 mt-2 italic">* Tối đa 20 câu</p>
                  </div>
                </div>
                <button 
                  onClick={handleGenerate}
                  disabled={isGenerating || !topic.trim()}
                  className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 text-white rounded-2xl font-bold text-lg shadow-lg shadow-emerald-100 transition-all flex items-center justify-center gap-2"
                >
                  {isGenerating ? (
                    <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Plus size={24} />
                  )}
                  {isGenerating ? 'Đang tạo câu hỏi...' : 'Tạo câu hỏi bằng AI'}
                </button>
              </div>
            </section>

            {/* Manual Add Button - Always visible */}
            <section className="bg-white rounded-3xl p-6 border border-black/5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-8 bg-indigo-500 rounded-full" />
                <h2 className="text-2xl font-semibold italic serif">Nhập thủ công</h2>
              </div>
              <button 
                onClick={handleAddQuestion}
                className="w-full py-4 bg-indigo-500 hover:bg-indigo-600 text-white rounded-2xl font-bold text-lg shadow-lg shadow-indigo-100 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={24} />
                Thêm câu hỏi thủ công
              </button>
            </section>

            {/* Questions Editor */}
            {questions.length > 0 && (
              <section className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-8 bg-amber-500 rounded-full" />
                    <h2 className="text-2xl font-semibold italic serif">Danh sách câu hỏi ({questions.length})</h2>
                  </div>
                  <button 
                    onClick={startGame}
                    className="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-lg shadow-indigo-100 transition-all flex items-center gap-2"
                  >
                    <Play size={20} fill="currentColor" />
                    Bắt đầu trò chơi
                  </button>
                </div>

                <div className="grid gap-4">
                  {questions.map((q, idx) => (
                    <div key={idx} className="bg-white p-6 rounded-2xl border border-black/5 shadow-sm group hover:border-indigo-200 transition-all">
                      <div className="flex gap-4">
                        <span className="flex-shrink-0 w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center font-bold text-gray-500">{idx + 1}</span>
                        <div className="flex-grow space-y-4">
                          {/* Question text + image */}
                          <div className="space-y-2">
                            <input 
                              value={q.question}
                              onChange={(e) => handleUpdateQuestion(idx, { ...q, question: e.target.value })}
                              className="w-full text-lg font-medium bg-transparent border-b border-transparent focus:border-indigo-500 outline-none pb-1"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleImageUpload(idx, 'questionImage')}
                                className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-500 transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50"
                                title="Thêm ảnh cho câu hỏi"
                              >
                                <ImagePlus size={14} />
                                Ảnh câu hỏi
                              </button>
                              {q.questionImage && (
                                <div className="relative inline-block">
                                  <img src={q.questionImage} alt="" className="h-16 rounded-lg border border-gray-200 object-cover" />
                                  <button onClick={() => handleRemoveImage(idx, 'questionImage')} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs hover:bg-red-600"><X size={10} /></button>
                                </div>
                              )}
                            </div>
                          </div>
                          {/* Answer options */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <div className="flex items-center gap-3">
                                <button 
                                  onClick={() => handleUpdateQuestion(idx, { ...q, correct: 'A' })}
                                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${q.correct === 'A' ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300'}`}
                                >
                                  {q.correct === 'A' && <CheckCircle2 size={14} />}
                                </button>
                                <div className="flex-grow flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl">
                                  <span className="text-xs font-bold text-emerald-600">A</span>
                                  <input 
                                    value={q.A}
                                    onChange={(e) => handleUpdateQuestion(idx, { ...q, A: e.target.value })}
                                    className="bg-transparent outline-none w-full text-sm"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center gap-2 pl-9">
                                <button
                                  onClick={() => handleImageUpload(idx, 'imageA')}
                                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-emerald-500 transition-colors px-2 py-1 rounded-lg hover:bg-emerald-50"
                                  title="Thêm ảnh cho đáp án A"
                                >
                                  <ImagePlus size={12} />
                                  Ảnh
                                </button>
                                {q.imageA && (
                                  <div className="relative inline-block">
                                    <img src={q.imageA} alt="" className="h-12 rounded-lg border border-gray-200 object-cover" />
                                    <button onClick={() => handleRemoveImage(idx, 'imageA')} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs hover:bg-red-600"><X size={10} /></button>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center gap-3">
                                <button 
                                  onClick={() => handleUpdateQuestion(idx, { ...q, correct: 'B' })}
                                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${q.correct === 'B' ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-gray-300'}`}
                                >
                                  {q.correct === 'B' && <CheckCircle2 size={14} />}
                                </button>
                                <div className="flex-grow flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl">
                                  <span className="text-xs font-bold text-indigo-600">B</span>
                                  <input 
                                    value={q.B}
                                    onChange={(e) => handleUpdateQuestion(idx, { ...q, B: e.target.value })}
                                    className="bg-transparent outline-none w-full text-sm"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center gap-2 pl-9">
                                <button
                                  onClick={() => handleImageUpload(idx, 'imageB')}
                                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-500 transition-colors px-2 py-1 rounded-lg hover:bg-indigo-50"
                                  title="Thêm ảnh cho đáp án B"
                                >
                                  <ImagePlus size={12} />
                                  Ảnh
                                </button>
                                {q.imageB && (
                                  <div className="relative inline-block">
                                    <img src={q.imageB} alt="" className="h-12 rounded-lg border border-gray-200 object-cover" />
                                    <button onClick={() => handleRemoveImage(idx, 'imageB')} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs hover:bg-red-600"><X size={10} /></button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                        <button 
                          onClick={() => handleDeleteQuestion(idx)}
                          className="text-gray-300 hover:text-red-500 transition-colors p-2"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {gameState === 'READY' && (
          <div className="max-w-2xl mx-auto py-12 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            {/* Game Mode Selector */}
            <div className="bg-white rounded-3xl p-6 border border-black/5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-8 bg-purple-500 rounded-full" />
                <h2 className="text-xl font-black">Chọn chế độ chơi</h2>
              </div>
              <div className="grid grid-cols-5 gap-3">
                <button onClick={() => setGameMode('TILT')} className={`p-4 rounded-2xl border-2 transition-all text-center ${gameMode === 'TILT' ? 'bg-purple-500 border-purple-500 text-white shadow-lg shadow-purple-200 scale-[1.02]' : 'border-gray-200 hover:border-purple-200 hover:bg-purple-50'}`}>
                  <Move size={24} className="mx-auto mb-2" />
                  <div className="font-bold text-sm">Nghiêng đầu</div>
                  <div className="text-xs opacity-70 mt-1">Camera + góc đầu</div>
                </button>
                <button onClick={() => setGameMode('JUMP')} className={`p-4 rounded-2xl border-2 transition-all text-center ${gameMode === 'JUMP' ? 'bg-indigo-500 border-indigo-500 text-white shadow-lg shadow-indigo-200 scale-[1.02]' : 'border-gray-200 hover:border-indigo-200 hover:bg-indigo-50'}`}>
                  <ArrowLeft size={20} className="inline" /><ArrowRight size={20} className="inline" />
                  <div className="font-bold text-sm mt-2">Nhảy trái/phải</div>
                  <div className="text-xs opacity-70 mt-1">Camera + vị trí</div>
                </button>
                <button onClick={() => setGameMode('CLAP')} className={`p-4 rounded-2xl border-2 transition-all text-center ${gameMode === 'CLAP' ? 'bg-pink-500 border-pink-500 text-white shadow-lg shadow-pink-200 scale-[1.02]' : 'border-gray-200 hover:border-pink-200 hover:bg-pink-50'}`}>
                  <Mic size={24} className="mx-auto mb-2" />
                  <div className="font-bold text-sm">Vỗ tay</div>
                  <div className="text-xs opacity-70 mt-1">Microphone</div>
                </button>
                <button onClick={() => setGameMode('HANDS')} className={`p-4 rounded-2xl border-2 transition-all text-center ${gameMode === 'HANDS' ? 'bg-cyan-500 border-cyan-500 text-white shadow-lg shadow-cyan-200 scale-[1.02]' : 'border-gray-200 hover:border-cyan-200 hover:bg-cyan-50'}`}>
                  <Hand size={24} className="mx-auto mb-2" />
                  <div className="font-bold text-sm">Giơ ngón tay</div>
                  <div className="text-xs opacity-70 mt-1">Camera + tay</div>
                </button>
                <button onClick={() => setGameMode('GROUP')} className={`p-4 rounded-2xl border-2 transition-all text-center ${gameMode === 'GROUP' ? 'bg-amber-500 border-amber-500 text-white shadow-lg shadow-amber-200 scale-[1.02]' : 'border-gray-200 hover:border-amber-200 hover:bg-amber-50'}`}>
                  <Users size={24} className="mx-auto mb-2" />
                  <div className="font-bold text-sm">Chơi nhóm</div>
                  <div className="text-xs opacity-70 mt-1">Không camera</div>
                </button>
              </div>
            </div>

            <div className="bg-white rounded-3xl p-8 border border-black/5 shadow-sm text-center">
              <div className={`w-20 h-20 rounded-2xl mx-auto mb-4 flex items-center justify-center text-white shadow-lg ${
                gameMode === 'TILT' ? 'bg-purple-500' : gameMode === 'JUMP' ? 'bg-indigo-500' : gameMode === 'CLAP' ? 'bg-pink-500' : gameMode === 'HANDS' ? 'bg-cyan-500' : 'bg-amber-500'
              }`}>
                {gameMode === 'TILT' && <Move size={40} />}
                {gameMode === 'JUMP' && <><ArrowLeft size={24} /><ArrowRight size={24} /></>}
                {gameMode === 'CLAP' && <Mic size={40} />}
                {gameMode === 'HANDS' && <Hand size={40} />}
                {gameMode === 'GROUP' && <Users size={40} />}
              </div>
              <h2 className="text-3xl font-black mb-2">
                {gameMode === 'TILT' ? 'Nghiêng đầu' : gameMode === 'JUMP' ? 'Nhảy trái/phải' : gameMode === 'CLAP' ? 'Vỗ tay' : gameMode === 'HANDS' ? 'Giơ ngón tay' : 'Chơi nhóm'}
              </h2>
              <div className="text-gray-500 mb-6 space-y-1">
                {gameMode === 'TILT' && (
                  <><p>📷 Camera nhận diện góc nghiêng đầu</p><p><b>Nghiêng trái = A</b> · <b>Nghiêng phải = B</b></p><p>Giữ 2 giây để xác nhận</p></>
                )}
                {gameMode === 'JUMP' && (
                  <><p>📷 Camera nhận diện vị trí người</p><p><b>Nhảy sang trái = A</b> · <b>Nhảy sang phải = B</b></p><p>Đứng ở giữa để chờ, nhảy sang bên nào xác nhận bên đó trong 2s</p></>
                )}
                {gameMode === 'CLAP' && (
                  <><p>🎤 Microphone nhận diện tiếng vỗ tay</p><p><b>Vỗ 1 lần = A</b> · <b>Vỗ 2 lần = B</b></p><p>Vỗ tay xong đợi xác nhận 2s</p></>
                )}
                {gameMode === 'HANDS' && (
                  <><p>📷 Camera nhận diện số ngón tay giơ lên</p><p><b>Giơ 1 ngón = A</b> · <b>Giơ 2 ngón = B</b></p><p>Giữ 1.5 giây để xác nhận</p></>
                )}
                {gameMode === 'GROUP' && (
                  <><p>👥 Không cần camera</p><p>HS nhảy sang bên đáp án</p><p>Hết giờ → hiện đáp án đúng</p></>
                )}
              </div>
            </div>

            {/* Settings */}
            <div className="bg-white rounded-3xl p-8 border border-black/5 shadow-sm space-y-5">
              <h3 className="font-bold text-lg flex items-center gap-2"><Settings size={18} /> Cài đặt trước khi chơi</h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="text-sm font-medium text-gray-500 mb-2 block">⏱ Thời gian mỗi câu ({timeLimit}s)</label>
                  <input type="range" min="5" max="60" value={timeLimit} onChange={(e) => setTimeLimit(parseInt(e.target.value))} className="w-full accent-indigo-500" />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-500 mb-2 block">🔊 Âm lượng SFX ({Math.round(sfxVolume * 100)}%)</label>
                  <input type="range" min="0" max="100" value={sfxVolume * 100} onChange={(e) => setSfxVolume(parseInt(e.target.value) / 100)} className="w-full accent-emerald-500" />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-500 mb-2 block">🎵 Nhạc nền ({Math.round(bgmVolume * 100)}%)</label>
                  <input type="range" min="0" max="100" value={bgmVolume * 100} onChange={(e) => setBgmVolume(parseInt(e.target.value) / 100)} className="w-full accent-amber-500" />
                </div>
                <div className="flex items-end gap-3">
                  <button onClick={handleBgmUpload} className="px-4 py-2.5 bg-amber-100 text-amber-700 rounded-xl hover:bg-amber-200 transition-colors font-medium text-sm">
                    {bgmUrl ? '🎵 Đã chọn nhạc' : '📂 Tải nhạc nền'}
                  </button>
                  {bgmUrl && <button onClick={() => setBgmUrl('')} className="text-sm text-red-400 hover:text-red-600 py-2">Xóa</button>}
                </div>
              </div>
              <div className="text-xs text-gray-400">📋 {questions.length} câu hỏi đã sẵn sàng</div>
            </div>

            {/* Start Button */}
            <button
              onClick={beginPlaying}
              className="w-full py-6 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white rounded-3xl font-black text-2xl shadow-2xl shadow-indigo-200 transition-all hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-3"
            >
              <Play size={32} fill="currentColor" />
              BẮT ĐẦU CHƠI
            </button>
            <button onClick={() => setGameState('TEACHER')} className="w-full py-3 text-gray-400 hover:text-gray-600 font-medium transition-colors">
              ← Quay lại cài đặt
            </button>
          </div>
        )}

        {gameState === 'PLAYING' && (
          <div className="relative h-[calc(100vh-12rem)] flex flex-col gap-6 animate-in fade-in zoom-in duration-500">
            {/* Question Header */}
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-4">
                <div className="px-4 py-1.5 bg-indigo-100 text-indigo-700 rounded-full text-sm font-bold uppercase tracking-widest">
                  Câu {currentQuestionIndex + 1} / {questions.length}
                </div>
                <div className={`px-4 py-1.5 rounded-full text-sm font-bold flex items-center gap-2 ${timeLeft < 4 ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-amber-100 text-amber-700'}`}>
                  <Timer size={14} />
                  {timeLeft}s
                </div>
                <div className="px-4 py-1.5 bg-emerald-100 text-emerald-700 rounded-full text-sm font-bold">
                  Điểm: {score}
                </div>
              </div>
              <h2 className="text-3xl md:text-5xl font-black text-gray-900 max-w-4xl mx-auto leading-tight">
                {questions[currentQuestionIndex].question}
              </h2>
              {questions[currentQuestionIndex].questionImage && (
                <img src={questions[currentQuestionIndex].questionImage} alt="" className="max-h-[20vh] md:max-h-[25vh] mx-auto rounded-2xl border border-gray-200 shadow-md object-contain" />
              )}
            </div>

            {/* Game Area - 3 Columns: Card A | Camera | Card B */}
            <div className="flex-grow flex items-stretch justify-center gap-4 px-4 relative">
              
              {/* Answer A - Left Card */}
              <div className="flex-1 flex items-center justify-center max-w-sm">
                <div className={`relative w-full h-full rounded-3xl border-4 flex flex-col items-center justify-center p-4 text-center transition-all duration-500 overflow-hidden ${
                  selection === 'A' 
                    ? 'bg-emerald-500 border-emerald-400 text-white shadow-[0_0_60px_rgba(16,185,129,0.5)] scale-[1.03]' 
                    : 'bg-white border-gray-200 text-gray-400 shadow-lg hover:shadow-xl'
                }`}>
                  <div className={`text-3xl font-black mb-1 ${selection === 'A' ? 'text-white' : 'text-emerald-500'}`}>A</div>
                  {questions[currentQuestionIndex].imageA && (
                    <img src={questions[currentQuestionIndex].imageA} alt="" className="max-h-[40%] w-auto max-w-[90%] rounded-xl mb-2 object-contain" />
                  )}
                  <div className={`${getFontSize(questions[currentQuestionIndex].A)} font-black leading-tight break-words w-full flex-grow flex items-center justify-center`}>
                    {questions[currentQuestionIndex].A}
                  </div>
                  
                  {/* Selection Arrow */}
                  {selection === 'A' && (
                    <div className="absolute top-4 right-4 text-white/60 animate-bounce">
                      <ArrowLeft size={28} />
                    </div>
                  )}
                  
                  {/* Progress Bar */}
                  {selection === 'A' && (
                    <div className="absolute bottom-0 left-0 right-0 h-2 bg-white/20">
                      <div 
                        className="h-full bg-white transition-all duration-150 ease-linear" 
                        style={{ width: `${selectionProgress * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Central Column: Camera for TILT/JUMP/HANDS, Countdown for GROUP, Mic for CLAP */}
              {(gameMode === 'GROUP' || gameMode === 'CLAP') ? (
                <div className="relative flex-shrink-0 w-[250px] md:w-[300px] flex items-center justify-center">
                  <div className={`w-full h-full rounded-3xl border-4 flex flex-col items-center justify-center transition-all duration-500 shadow-2xl ${
                    feedback === 'TIMEOUT' && selection ? (selection === 'A' ? 'bg-emerald-100 border-emerald-400' : 'bg-indigo-100 border-indigo-400') 
                    : selection ? (selection === 'A' ? 'bg-emerald-50 border-emerald-300' : 'bg-indigo-50 border-indigo-300')
                    : 'bg-white border-gray-200'
                  }`}>
                    {gameMode === 'CLAP' && !feedback ? (
                      <>
                        <Mic size={40} className={`mb-2 transition-all ${clapCount > 0 ? 'text-pink-500 scale-125' : micLevel > 0.3 ? 'text-pink-400' : 'text-gray-300'}`} />
                        {/* Mic level bar */}
                        <div className="w-3/4 h-3 bg-gray-100 rounded-full overflow-hidden mb-2">
                          <div 
                            className={`h-full rounded-full transition-all duration-75 ${micLevel > 0.6 ? 'bg-red-500' : micLevel > 0.3 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                            style={{ width: `${micLevel * 100}%` }}
                          />
                        </div>
                        <div className="text-5xl font-black text-gray-800">{clapCount || '—'}</div>
                        <div className="text-xs text-gray-400 mt-1">lần vỗ tay</div>
                        <div className={`text-2xl font-bold mt-2 ${timeLeft < 4 ? 'text-red-500 animate-pulse' : 'text-gray-300'}`}>{timeLeft}s</div>
                        {selection && (
                          <div className={`mt-2 text-lg font-bold ${selection === 'A' ? 'text-emerald-500' : 'text-indigo-500'}`}>
                            → {selection}
                          </div>
                        )}
                      </>
                    ) : !feedback ? (
                      <>
                        <div className={`text-7xl font-black ${timeLeft < 4 ? 'text-red-500 animate-pulse' : 'text-gray-300'}`}>{timeLeft}</div>
                        <div className="text-sm text-gray-400 font-bold mt-2 uppercase tracking-widest">Giây</div>
                        <div className="text-xs text-gray-300 mt-4">HS nhảy sang bên đáp án</div>
                      </>
                    ) : feedback === 'TIMEOUT' ? (
                      <div className="text-center">
                        <div className="text-xl font-black text-gray-900 mb-2">Đáp án đúng:</div>
                        <div className={`text-5xl font-black ${questions[currentQuestionIndex].correct === 'A' ? 'text-emerald-500' : 'text-indigo-500'}`}>
                          {questions[currentQuestionIndex].correct}
                        </div>
                      </div>
                    ) : (
                      <div className={`text-center ${feedback === 'CORRECT' ? 'text-emerald-500' : 'text-red-500'}`}>
                        {feedback === 'CORRECT' ? <CheckCircle2 size={64} className="mx-auto mb-2" /> : <XCircle size={64} className="mx-auto mb-2" />}
                        <div className="text-xl font-black">{feedback === 'CORRECT' ? 'Đúng!' : 'Sai!'}</div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
              <div className="relative flex-shrink-0 w-[340px] md:w-[400px]">
                <div className={`w-full h-full rounded-3xl border-4 overflow-hidden transition-all duration-500 shadow-2xl relative ${
                  selection === 'A' ? 'border-emerald-500' : selection === 'B' ? 'border-indigo-500' : 'border-gray-200'
                }`}>
                  <video 
                    ref={videoRef}
                    className="w-full h-full object-cover scale-x-[-1]"
                    autoPlay
                    playsInline
                    muted
                  />
                  
                  {/* Zone Divider Overlay */}
                  <div className="absolute inset-0 pointer-events-none">
                    {gameMode === 'JUMP' && (
                      <>
                        <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-white/40" style={{ left: '35%' }} />
                        <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-white/40" style={{ left: '65%' }} />
                      </>
                    )}
                    
                    {/* Zone Labels */}
                    <div className="absolute top-3 left-2 bg-emerald-500/70 text-white text-xs font-bold px-2 py-1 rounded-lg backdrop-blur-sm">A</div>
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-gray-500/50 text-white text-xs font-bold px-2 py-1 rounded-lg backdrop-blur-sm">
                      {gameMode === 'TILT' ? 'Thẳng đầu' : 'Đứng đây'}
                    </div>
                    <div className="absolute top-3 right-2 bg-indigo-500/70 text-white text-xs font-bold px-2 py-1 rounded-lg backdrop-blur-sm">B</div>
                    
                    {/* Active zone highlight */}
                    {selection === 'A' && (
                      <div className="absolute top-0 bottom-0 right-0 bg-emerald-500/15 border-r-4 border-emerald-400" style={{ left: '65%' }} />
                    )}
                    {selection === 'B' && (
                      <div className="absolute top-0 bottom-0 left-0 bg-indigo-500/15 border-l-4 border-indigo-400" style={{ right: '65%' }} />
                    )}

                    {/* Face position indicator dot */}
                    {faceDetected && (
                      <div 
                        className={`absolute bottom-4 w-4 h-4 rounded-full -translate-x-1/2 transition-all duration-150 shadow-lg ${
                          selection === 'A' ? 'bg-emerald-400' : selection === 'B' ? 'bg-indigo-400' : 'bg-white'
                        }`}
                        style={{ left: `${(1 - facePosition) * 100}%` }}
                      />
                    )}
                  </div>

                  {/* Feedback Overlay */}
                  {feedback && (
                    <div className={`absolute inset-0 flex items-center justify-center z-20 animate-in zoom-in duration-300 ${feedback === 'CORRECT' ? 'bg-emerald-500/90' : 'bg-red-500/90'} backdrop-blur-sm`}>
                      {feedback === 'CORRECT' ? (
                        <CheckCircle2 size={80} className="text-white animate-bounce" />
                      ) : feedback === 'WRONG' ? (
                        <XCircle size={80} className="text-white animate-shake" />
                      ) : (
                        <div className="text-center text-white">
                          <Timer size={60} className="mx-auto mb-2" />
                          <span className="font-black uppercase text-xl">Hết giờ!</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Answer B - Right Card */}
              <div className="flex-1 flex items-center justify-center max-w-sm">
                <div className={`relative w-full h-full rounded-3xl border-4 flex flex-col items-center justify-center p-4 text-center transition-all duration-500 overflow-hidden ${
                  selection === 'B' 
                    ? 'bg-indigo-500 border-indigo-400 text-white shadow-[0_0_60px_rgba(99,102,241,0.5)] scale-[1.03]' 
                    : 'bg-white border-gray-200 text-gray-400 shadow-lg hover:shadow-xl'
                }`}>
                  <div className={`text-3xl font-black mb-1 ${selection === 'B' ? 'text-white' : 'text-indigo-500'}`}>B</div>
                  {questions[currentQuestionIndex].imageB && (
                    <img src={questions[currentQuestionIndex].imageB} alt="" className="max-h-[40%] w-auto max-w-[90%] rounded-xl mb-2 object-contain" />
                  )}
                  <div className={`${getFontSize(questions[currentQuestionIndex].B)} font-black leading-tight break-words w-full flex-grow flex items-center justify-center`}>
                    {questions[currentQuestionIndex].B}
                  </div>
                  
                  {/* Selection Arrow */}
                  {selection === 'B' && (
                    <div className="absolute top-4 left-4 text-white/60 animate-bounce">
                      <ArrowRight size={28} />
                    </div>
                  )}
                  
                  {/* Progress Bar */}
                  {selection === 'B' && (
                    <div className="absolute bottom-0 left-0 right-0 h-2 bg-white/20">
                      <div 
                        className="h-full bg-white transition-all duration-150 ease-linear" 
                        style={{ width: `${selectionProgress * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Camera Error Overlay */}
              {cameraError && (
                <div className="absolute inset-0 bg-gray-900/90 backdrop-blur-md flex flex-col items-center justify-center p-8 text-center text-white z-50 rounded-3xl">
                  <Camera size={64} className="mb-4 text-gray-500" />
                  <h3 className="text-2xl font-bold mb-2">{cameraError}</h3>
                  <p className="text-gray-400 mb-6">Vui lòng kiểm tra cài đặt trình duyệt và đảm bảo Camera đã được kết nối.</p>
                  <button 
                    onClick={() => window.location.reload()}
                    className="px-8 py-3 bg-white text-gray-900 rounded-2xl font-bold hover:bg-gray-200 transition-all shadow-xl"
                  >
                    Tải lại trang
                  </button>
                </div>
              )}
            </div>

            {/* Mode-aware Instructions */}
            <div className="text-center">
              {gameMode === 'GROUP' ? (
                <div className="text-gray-400 font-bold text-xs uppercase tracking-widest">
                  <Users size={14} className="inline mr-2" />
                  Chơi nhóm — Hết giờ sẽ hiện đáp án đúng
                </div>
              ) : gameMode === 'CLAP' ? (
                <div className="text-gray-400 font-bold text-xs uppercase tracking-widest">
                  <Mic size={14} className="inline mr-2" />
                  Vỗ 1 lần = A · Vỗ 2 lần = B
                </div>
              ) : gameMode === 'HANDS' ? (
                <div className="text-gray-400 font-bold text-xs uppercase tracking-widest">
                  <Hand size={14} className="inline mr-2" />
                  Giơ 1 ngón = A · Giơ 2+ ngón = B — Đang thấy: {handsCount} ngón
                </div>
              ) : (
              <div className="flex items-center justify-center gap-8">
                <div className={`flex items-center gap-3 transition-all duration-300 ${selection === 'A' ? 'text-emerald-600 scale-110' : 'text-gray-400'}`}>
                  <ArrowLeft size={18} className={selection === 'A' ? 'animate-bounce' : ''} />
                  <span className="font-bold uppercase tracking-widest text-xs">
                    {gameMode === 'TILT' ? 'Nghiêng trái = A' : 'Nhảy trái = A'}
                  </span>
                </div>
                <div className="w-px h-4 bg-gray-200" />
                <div className={`flex items-center gap-3 transition-all duration-300 ${selection === 'B' ? 'text-indigo-600 scale-110' : 'text-gray-400'}`}>
                  <span className="font-bold uppercase tracking-widest text-xs">
                    {gameMode === 'TILT' ? 'Nghiêng phải = B' : 'Nhảy phải = B'}
                  </span>
                  <ArrowRight size={18} className={selection === 'B' ? 'animate-bounce' : ''} />
                </div>
              </div>
              )}
            </div>
          </div>
        )}

        {gameState === 'FINISHED' && (
          <div className="max-w-2xl mx-auto text-center py-20 space-y-8 animate-in zoom-in duration-700">
            <div className="relative inline-block">
              <div className="absolute inset-0 bg-amber-400 blur-3xl opacity-20 animate-pulse" />
              <div className="relative bg-white p-12 rounded-[3rem] border border-black/5 shadow-2xl">
                <h2 className="text-4xl font-black mb-2">Hoàn thành!</h2>
                <p className="text-gray-500 font-medium mb-8">Bạn đã trả lời xong tất cả câu hỏi.</p>
                
                <div className="flex items-center justify-center gap-8 mb-10">
                  <div className="text-center">
                    <div className="text-6xl font-black text-emerald-500">{score}</div>
                    <div className="text-sm font-bold text-gray-400 uppercase tracking-widest">Đúng</div>
                  </div>
                  <div className="w-px h-16 bg-gray-100" />
                  <div className="text-center">
                    <div className="text-6xl font-black text-gray-300">{questions.length}</div>
                    <div className="text-sm font-bold text-gray-400 uppercase tracking-widest">Tổng</div>
                  </div>
                </div>

                <div className="space-y-4 text-left mb-10">
                  <h3 className="text-xl font-bold flex items-center gap-2">
                    <CheckCircle2 size={24} className="text-emerald-500" />
                    Xem lại kết quả
                  </h3>
                  <div className="max-h-60 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
                    {questions.map((q, idx) => (
                      <div key={idx} className="p-4 bg-gray-50 rounded-2xl border border-black/5">
                        <div className="text-sm font-bold text-gray-400 mb-1">Câu {idx + 1}</div>
                        <div className="font-medium mb-2">{q.question}</div>
                        <div className="flex items-center gap-4 text-xs">
                          <div className={`px-2 py-1 rounded-lg ${q.correct === 'A' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                            A: {q.A}
                          </div>
                          <div className={`px-2 py-1 rounded-lg ${q.correct === 'B' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                            B: {q.B}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-400">Bạn chọn:</span>
                          {userAnswers[idx] === 'TIMEOUT' ? (
                            <span className="text-xs font-bold text-red-500 uppercase">Hết giờ</span>
                          ) : userAnswers[idx] === q.correct ? (
                            <span className="text-xs font-bold text-emerald-600 uppercase">Đúng ({userAnswers[idx]})</span>
                          ) : (
                            <span className="text-xs font-bold text-red-600 uppercase">Sai ({userAnswers[idx] || 'Chưa chọn'})</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <button 
                  onClick={() => setGameState('TEACHER')}
                  className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-xl shadow-xl shadow-indigo-100 transition-all"
                >
                  Quay lại trang chính
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        .animate-shake {
          animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both;
        }
        .serif { font-family: 'Georgia', serif; }
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}} />
    </div>
  );
}
