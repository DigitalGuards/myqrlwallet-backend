import express from "express";
import nodemailer from "nodemailer";
import rateLimit from 'express-rate-limit';
import axios from "axios";

const appRouter = express.Router();

const supportRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: { message: "Too many requests, please try again later." }
});

appRouter.post("/support", supportRateLimit, (req, res) => {
    const { name, email, message, subject } = req.body;

    if (!name || !email || !message || !subject) {
        return res.status(400).json({ message: "Missing required fields" });
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_TOKEN
        }
    });

    const mailOptions = {
        from: process.env.SMTP_FROM,
        to: process.env.SMTP_TO,
        subject: subject,
        html: `<h1>Support Request</h1>
               <p>Dear Support Team,</p>
               <p>You have received a new support request from <strong>${name}</strong>. Please find the details below:</p>
               <p><strong>Message:</strong> ${message}</p>
               <p>Kindly address this request at your earliest convenience.</p>
               <p>Best regards,</p>
               <p>TheQRLWallet Team</p>
               <p>Email: ${process.env.SMTP_FROM}</p>`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log(error);
            return res.status(500).json({ message: "Failed to send support request email" });
        } else {
            console.log("Support email sent: " + info.response);
            const confirmationMailOptions = {
                from: process.env.SMTP_FROM,
                to: email,
                subject: "Confirmation of Your Support Request",
                html: `<h1>Support Request Confirmation</h1>
                       <p>Dear ${name},</p>
                       <p>Thank you for reaching out to our support team. We have received your request and our team will get back to you shortly.</p>
                       <p>We appreciate your patience and understanding.</p>
                       <p>Best regards,</p>
                       <p>TheQRLWallet Team</p>
                       <p>Email: ${process.env.SMTP_FROM}</p>`
            };
            transporter.sendMail(confirmationMailOptions, (error, info) => {
                if (error) {
                    console.log("Error sending confirmation email: ", error);
                    return res.status(500).json({ message: "Failed to send confirmation email" });
                } else {
                    console.log("Confirmation email sent: " + info.response);
                    res.status(200).json({ message: "Support request sent successfully to " + process.env.SMTP_TO });
                }
            });
        }
    });
});

appRouter.post("/tx-history", async (req, res) => {
    const { address, page = 1, limit = 5 } = req.body;
    const formattedAddress = 'Z' + address.toLowerCase().substring(1);
    axios.get(`https://zondscan.com/api/address/${formattedAddress}/transactions`, {
        params: {
            page: page,
            limit: limit
        }
    })
    .then(response => {
        console.log(response.data);
        res.status(200).json(response.data);
    })
    .catch(error => {
        console.log(error);
        res.status(500).json({ message: "Failed to get tx history" });
    });
});

export default appRouter;
