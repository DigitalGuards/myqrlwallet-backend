import express from 'express';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'app-routes' });

/** Escape HTML to prevent injection in email templates. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const appRouter = express.Router();

const supportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: { message: 'Too many requests, please try again later.' },
});

const txHistoryRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { message: 'Too many requests, please try again later.' },
});

appRouter.post('/support', supportRateLimit, (req, res) => {
  const { name, email, message, subject } = req.body;

  if (!name || !email || !message || !subject) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_TOKEN,
    },
  });

  const safeName = escapeHtml(name);
  const safeMessage = escapeHtml(message);

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: process.env.SMTP_TO,
    subject: subject,
    html: `<h1>Support Request</h1>
               <p>Dear Support Team,</p>
               <p>You have received a new support request from <strong>${safeName}</strong>. Please find the details below:</p>
               <p><strong>Message:</strong> ${safeMessage}</p>
               <p>Kindly address this request at your earliest convenience.</p>
               <p>Best regards,</p>
               <p>TheQRLWallet Team</p>
               <p>Email: ${process.env.SMTP_FROM}</p>`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      log.error({ error }, 'Failed to send support request email');
      return res.status(500).json({ message: 'Failed to send support request email' });
    } else {
      log.info({ response: info.response }, 'Support email sent');
      const confirmationMailOptions = {
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Confirmation of Your Support Request',
        html: `<h1>Support Request Confirmation</h1>
                       <p>Dear ${safeName},</p>
                       <p>Thank you for reaching out to our support team. We have received your request and our team will get back to you shortly.</p>
                       <p>We appreciate your patience and understanding.</p>
                       <p>Best regards,</p>
                       <p>TheQRLWallet Team</p>
                       <p>Email: ${process.env.SMTP_FROM}</p>`,
      };
      transporter.sendMail(confirmationMailOptions, (error, info) => {
        if (error) {
          log.error({ error }, 'Failed to send confirmation email');
          return res.status(500).json({ message: 'Failed to send confirmation email' });
        } else {
          log.info({ response: info.response }, 'Confirmation email sent');
          res
            .status(200)
            .json({ message: 'Support request sent successfully to ' + process.env.SMTP_TO });
        }
      });
    }
  });
});

appRouter.post('/tx-history', txHistoryRateLimit, async (req, res) => {
  const { address, page = 1, limit = 5 } = req.body;

  // Validate address format (Q + 40 hex chars)
  if (!address || typeof address !== 'string' || !/^Q[a-fA-F0-9]{40}$/i.test(address)) {
    return res.status(400).json({ message: 'Invalid address format' });
  }

  const formattedAddress = 'Q' + address.slice(1).toLowerCase();
  axios
    .get(`https://zondscan.com/api/address/${formattedAddress}/transactions`, {
      params: {
        page: page,
        limit: limit,
      },
    })
    .then((response) => {
      log.debug({ address: formattedAddress }, 'Tx history fetched');
      res.status(200).json(response.data);
    })
    .catch((error) => {
      log.error({ error, address: formattedAddress }, 'Failed to get tx history');
      res.status(500).json({ message: 'Failed to get tx history' });
    });
});

export default appRouter;
