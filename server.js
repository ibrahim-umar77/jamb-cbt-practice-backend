import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.get("/api/test", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS connected");

    res.json({
      success: true,
      message: "Backend connected to MySQL",
      database: "jamb_cbt",
      result: rows,
    });
  } catch (error) {
    console.error("Database error:", error);

    res.status(500).json({
      success: false,
      message: "Could not connect to MySQL",
      error: error.message,
    });
  }
});

app.get("/api/subjects", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        s.id,
        s.name,
        s.description
      FROM subjects s
      INNER JOIN practice_sets ps
        ON ps.subject_id = s.id
      GROUP BY s.id, s.name, s.description
      ORDER BY s.id
    `);

    res.json({
      success: true,
      subjects: rows,
    });
  } catch (error) {
    console.error("Subjects error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load subjects",
      error: error.message,
    });
  }
});

app.get("/api/practice-sets/:subjectId", async (req, res) => {
  try {
    const { subjectId } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        ps.id,
        ps.subject_id,
        ps.name,
        ps.description,
        COUNT(psq.id) AS total_questions
      FROM practice_sets ps
      LEFT JOIN practice_set_questions psq
        ON psq.practice_set_id = ps.id
      WHERE ps.subject_id = ?
      GROUP BY
        ps.id,
        ps.subject_id,
        ps.name,
        ps.description
      ORDER BY ps.id
      `,
      [subjectId]
    );

    res.json({
      success: true,
      practice_sets: rows,
    });
  } catch (error) {
    console.error("Practice sets error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load practice sets",
      error: error.message,
    });
  }
});

app.get("/api/questions/:practiceSetId", async (req, res) => {
  try {
    const { practiceSetId } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        psq.question_number,
        q.id,
        q.question_text,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        q.correct_answer,
        q.explanation
      FROM practice_set_questions psq
      INNER JOIN questions q
        ON q.id = psq.question_id
      WHERE psq.practice_set_id = ?
      ORDER BY psq.question_number
      `,
      [practiceSetId]
    );

    res.json({
      success: true,
      practice_set_id: Number(practiceSetId),
      total_questions: rows.length,
      questions: rows,
    });
  } catch (error) {
    console.error("Questions error:", error);

    res.status(500).json({
      success: false,
      message: "Could not load questions",
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running at http://localhost:${PORT}`);
});

app.post("/api/submit-practice", async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { practice_set_id, answers } = req.body;

    // Validate the request
    if (!practice_set_id || !answers) {
      return res.status(400).json({
        success: false,
        message: "Practice set ID and answers are required.",
      });
    }

    // Get the questions belonging to this practice set
    const [questions] = await connection.query(
      `
      SELECT
        q.id,
        q.correct_answer
      FROM practice_set_questions psq
      INNER JOIN questions q
        ON psq.question_id = q.id
      WHERE psq.practice_set_id = ?
      ORDER BY psq.question_number
      `,
      [practice_set_id]
    );

    if (questions.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No questions found for this practice set.",
      });
    }

    // Calculate score
    let score = 0;

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];

      const userAnswer = answers[i];

      if (
        userAnswer &&
        userAnswer.toUpperCase() === question.correct_answer.toUpperCase()
      ) {
        score++;
      }
    }

    const totalQuestions = questions.length;

    // Start database transaction
    await connection.beginTransaction();

    // Create the attempt
    const [attemptResult] = await connection.query(
      `
      INSERT INTO attempts
        (user_id, practice_set_id, score, total_questions)
      VALUES
        (?, ?, ?, ?)
      `,
      [
        null,
        practice_set_id,
        score,
        totalQuestions,
      ]
    );

    const attemptId = attemptResult.insertId;

    // Save each answer
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];

      const userAnswer = answers[i] || null;

      const isCorrect =
        userAnswer &&
        userAnswer.toUpperCase() === question.correct_answer.toUpperCase()
          ? 1
          : 0;

      await connection.query(
        `
        INSERT INTO attempt_answers
          (attempt_id, question_id, selected_answer, is_correct)
        VALUES
          (?, ?, ?, ?)
        `,
        [
          attemptId,
          question.id,
          userAnswer,
          isCorrect,
        ]
      );
    }

    // Save everything
    await connection.commit();

    // Calculate percentage
    const percentage = Math.round(
      (score / totalQuestions) * 100
    );

    res.json({
      success: true,
      message: "Practice submitted successfully.",
      attempt_id: attemptId,
      score: score,
      total_questions: totalQuestions,
      percentage: percentage,
    });

  } catch (error) {

    // Undo changes if something went wrong
    await connection.rollback();

    console.error(
      "Submit practice error:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Could not submit practice.",
      error: error.message,
    });

  } finally {

    connection.release();

  }
});