const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Static serve the PDFs
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));

// Ensure PDF output directory exists
const pdfDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

// Load rubric JSON
const rubricPath = path.join(__dirname, 'structured_cel_rubric.json');
const rubricData = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));

// Debug helper
const debugLog = (label, data) => {
  console.log(`\n=== ${label} ===`);
  console.dir(data, { depth: null });
};

// Extract rubric detail
function getCriterionDetail(criterionTitle) {
  const criterion = rubricData[criterionTitle];
  if (!criterion) return null;

  return Object.values(criterion).map(item => ({
    component: item.component,
    distinguished: item.distinguished
  }));
}

// Generate a PDF from text
function generatePDF(content, filename) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const filePath = path.join(pdfDir, filename);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    content.split('\n').forEach(line => {
      if (line.trim().endsWith(':')) {
        doc.font('Helvetica-Bold').fontSize(12).text(line, { lineGap: 6 });
      } else {
        doc.font('Helvetica').fontSize(11).text(line, { lineGap: 3 });
      }
    });

    doc.end();

    stream.on('finish', () => resolve(`/pdfs/${filename}`));
    stream.on('error', reject);
  });
}

// POST /grade
app.post('/grade', async (req, res) => {
  const { gradeLevel, intensity, rubric, submission } = req.body;

  debugLog('🟢 Incoming Payload', req.body);

  if (!submission || !submission.trim()) {
    return res.status(400).json({ error: 'Assignment text is required.' });
  }

  const rubricDetails = getCriterionDetail(rubric);
  if (!rubricDetails) {
    return res.status(400).json({ error: 'Invalid rubric criterion selected.' });
  }

  const prompt = `
You are an expert educator and grader specializing in detailed feedback on the assignments done by students and submitted to you by teachers.

Grade Level: ${gradeLevel}
Grading Intensity: ${intensity}
Rubric Criterion: ${rubric}

Rubric Components:
${rubricDetails.map(item => `• ${item.component}: ${item.distinguished}`).join('\n')}

Student Submission:
${submission}

Please analyze the student submission in depth. Your response must include:
1. A score (out of 4) with justification.
2. A breakdown of how the submission aligns or misaligns with each rubric component.
3. Clear references to specific sentences, ideas, or patterns in the submission. Also references to codes(mention the code itself when referring to it) in the criterion. 
4. Detailed feedback that explains:
   - What the student did well and how it meets rubric expectations.
   - Where the student fell short and how it could be improved.
   - How the performance reflects the selected grade level and intensity.
5. Use professional and instructional language. Structure your response as a comprehensive grading report.

This feedback is intended to guide both the student and the teacher, so clarity and completeness are essential.
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are an educational grading assistant.' },
        { role: 'user', content: prompt }
      ]
    });

    const result = completion.choices[0].message.content;
    debugLog('🧠 GPT-4 Response', result);

    const pdfFilename = `grading-${Date.now()}.pdf`;
    const pdfUrl = await generatePDF(result, pdfFilename);

    res.json({ success: true, result, pdfUrl });
  } catch (err) {
    console.error('🔥 GPT API Error:', err);
    res.status(500).json({ error: 'Error processing grading with GPT-4.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
