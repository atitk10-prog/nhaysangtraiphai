// Groq API service (OpenAI-compatible) - replaces Gemini

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface Question {
  question: string;
  A: string;
  B: string;
  correct: "A" | "B";
  questionImage?: string; // base64 data URL for question image
  imageA?: string;        // base64 data URL for answer A image
  imageB?: string;        // base64 data URL for answer B image
}

export async function generateQuestions(input: string, count: number = 5): Promise<Question[]> {
  const prompt = `Hãy đóng vai một giáo viên. Dựa vào chủ đề/nội dung sau: '${input}', hãy tạo ${count} câu hỏi trắc nghiệm. Mỗi câu hỏi chỉ có 2 đáp án A và B. Trả về định dạng JSON thuần túy có cấu trúc: [{"question": "...", "A": "...", "B": "...", "correct": "A" or "B"}]. Không trả về văn bản nào khác ngoài JSON.`;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "Bạn là một giáo viên tạo câu hỏi trắc nghiệm. Luôn trả về JSON thuần túy, không markdown, không giải thích."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: "json_object" }
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("No response from AI");

    // Parse - handle both array and object with "questions" key
    const parsed = JSON.parse(text);
    const questions: Question[] = Array.isArray(parsed) ? parsed : (parsed.questions || parsed.data || []);
    
    // Validate and clean
    return questions.map(q => ({
      question: q.question || "",
      A: q.A || "",
      B: q.B || "",
      correct: q.correct === "B" ? "B" : "A",
    }));
  } catch (error) {
    console.error("Error generating questions:", error);
    throw error;
  }
}
