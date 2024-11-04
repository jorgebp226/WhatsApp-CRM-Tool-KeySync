require('dotenv').config();
const express = require('express');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Configuración de DynamoDB
const dynamoDBClient = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const ddbDocClient = DynamoDBDocumentClient.from(dynamoDBClient);

// Configuración de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Almacenar clientes de WhatsApp por sub de Cognito
const whatsappClients = {};

// Función para almacenar el código QR en DynamoDB
const storeQRCode = async (sub, qrDataUrl) => {
    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Item: {
                sub: sub,
                qrCode: qrDataUrl,
                timestamp: new Date().toISOString()
            }
        };
        await ddbDocClient.send(new PutCommand(params));
        console.log(`Código QR almacenado en DynamoDB para sub: ${sub}`);
        return true;
    } catch (error) {
        console.error('Error al almacenar el código QR:', error);
        return false;
    }
};

// Endpoint para iniciar el proceso con límites configurables
app.post('/start/:sub', async (req, res) => {
    const { sub } = req.params;
    const { maxChats = 20, maxMessagesPerChat = 1000 } = req.body;
    
    console.log(`Solicitud recibida para iniciar cliente WhatsApp para sub: ${sub}`);
    console.log(`Configuración - Máximo de Chats: ${maxChats}, Máximo de Mensajes Por Chat: ${maxMessagesPerChat}`);

    if (whatsappClients[sub]) {
        console.log(`Cliente ya iniciado para sub: ${sub}`);
        return res.status(400).json({ message: 'Cliente ya iniciado para este sub.' });
    }

    // Inicializar cliente de WhatsApp
    const client = new Client({
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    let qrSent = false;

    client.on('qr', async (qr) => {
        console.log(`QR generado para sub: ${sub}`);
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            const stored = await storeQRCode(sub, qrDataUrl);
            
            if (stored && !qrSent) {
                qrSent = true;
                res.json({ 
                    message: 'Código QR generado y almacenado. Puede obtenerlo usando el endpoint /qr',
                    success: true
                });
            }
        } catch (err) {
            console.error('Error al generar QR:', err);
            if (!qrSent) {
                qrSent = true;
                res.status(500).json({ 
                    error: 'Error al generar el código QR',
                    success: false
                });
            }
        }
    });

    client.on('ready', () => {
        console.log(`Cliente WhatsApp listo para sub: ${sub}`);
        processChats(sub, maxChats, maxMessagesPerChat);
    });

    client.on('authenticated', () => {
        console.log(`Autenticado exitosamente para sub: ${sub}`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`Falló la autenticación para sub ${sub}:`, msg);
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente desconectado para sub ${sub}:`, reason);
        delete whatsappClients[sub];
    });

    console.log(`Inicializando cliente de WhatsApp para sub: ${sub}`);
    client.initialize();
    whatsappClients[sub] = client;
});

// Función para analizar la conversación con OpenAI
async function analyzeConversation(conversation) {
    console.log('Iniciando análisis de conversación con OpenAI...');
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente que extrae información relevante de conversaciones de WhatsApp para un CRM inmobiliario."
                },
                {
                    role: "user",
                    content: `
Eres un experto en crear CRMs para prospectos de un agente inmobiliario.
Analiza la siguiente conversación de WhatsApp entre el agente y un contacto y extrae la siguiente información en formato JSON. Si no parece una conversación con un cliente, establece "esCliente" como "No".

La respuesta debe estar en formato JSON válido con las siguientes claves:
1. necesitaSeguimiento (Si/No)
2. ultimoMensaje (fecha y hora en formato ISO)
3. esCliente (Si/No)
4. resumenConversacion
5. scoreLead (número entre 1-100)
6. estadoLead (una de las siguientes opciones: "Primeras conversaciones", "Presupuestos y casas presentadas", "Primeras visitas presenciales hechas", "Casa comprada – seguimiento")
7. viviendasEnviadas (lista de strings, pueden ser calles, links, etc.)

Conversación:
${conversation}

Asegúrate de que la respuesta sea únicamente el objeto JSON sin texto adicional.
`
                }
            ],
            temperature: 0.7,
            max_tokens: 500,
            n: 1,
            stop: null,
        });

        console.log('Análisis completado. Procesando respuesta de OpenAI...');
        let content = response.choices[0].message.content;

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Respuesta de OpenAI no contiene un JSON válido.');
        }

        const jsonString = jsonMatch[0];
        const parsedData = JSON.parse(jsonString);

        return {
            necesitaSeguimiento: parsedData.necesitaSeguimiento || 'No',
            ultimoMensaje: parsedData.ultimoMensaje || new Date().toISOString(),
            esCliente: parsedData.esCliente || 'No',
            resumenConversacion: parsedData.resumenConversacion || '',
            scoreLead: parsedData.scoreLead || 0,
            estadoLead: parsedData.estadoLead || '',
            viviendasEnviadas: parsedData.viviendasEnviadas || []
        };

    } catch (error) {
        console.error('Error al analizar la conversación:', error);
        return {
            necesitaSeguimiento: 'No',
            ultimoMensaje: new Date().toISOString(),
            esCliente: 'No',
            resumenConversacion: '',
            scoreLead: 0,
            estadoLead: '',
            viviendasEnviadas: []
        };
    }
}

// Función para procesar chats con límites configurables
const processChats = async (sub, maxChats, maxMessagesPerChat) => {
    console.log(`Iniciando proceso de chats para sub: ${sub}`);
    const client = whatsappClients[sub];
    if (!client) {
        console.error(`Cliente no encontrado para sub: ${sub}`);
        return;
    }

    try {
        const chats = await client.getChats();
        console.log(`Encontrados ${chats.length} chats para sub ${sub}. Comenzando exportación...`);

        const limitedChats = chats.slice(0, maxChats);

        for (let i = 0; i < limitedChats.length; i++) {
            const chat = limitedChats[i];
            console.log(`Procesando chat ${i + 1}/${limitedChats.length}: ${chat.name}`);

            let allMessages = [];
            let lastMessageId = null;
            const batchSize = 100;

            while (allMessages.length < maxMessagesPerChat) {
                const messages = await chat.fetchMessages({
                    limit: batchSize,
                    before: lastMessageId
                });
                if (messages.length === 0) break;
                allMessages = allMessages.concat(messages);
                lastMessageId = messages[messages.length - 1].id._serialized;
                console.log(`Mensajes obtenidos para ${chat.name}: ${allMessages.length}`);
            }

            const formattedMessages = allMessages.map(msg => ({
                de: msg.from === client.info.wid._serialized ? 'Tu' : msg.from,
                cuerpo: msg.body,
                timestamp: msg.timestamp
            }));

            const conversation = formattedMessages.map(m => `${m.de}: ${m.cuerpo}`).join('\n');
            const parsedData = await analyzeConversation(conversation);

            const item = {
                sub: sub,
                chatId: chat.id._serialized,
                nombreContacto: chat.name || '',
                telefono: chat.id.user || '',
                mensajes: formattedMessages,
                necesitaSeguimiento: parsedData.necesitaSeguimiento,
                ultimoMensaje: parsedData.ultimoMensaje,
                esCliente: parsedData.esCliente,
                resumenConversacion: parsedData.resumenConversacion,
                scoreLead: parsedData.scoreLead,
                estadoLead: parsedData.estadoLead,
                viviendasEnviadas: parsedData.viviendasEnviadas
            };

            try {
                const params = new PutCommand({ TableName: 'WhatsAppCRM', Item: item });
                await ddbDocClient.send(params);
                console.log(`Datos almacenados en DynamoDB para el chat ${chat.name}.`);
            } catch (dynamoError) {
                console.error(`Error al almacenar datos en DynamoDB para el chat ${chat.name}:`, dynamoError);
            }
        }

        console.log(`Exportación completada para sub ${sub}.`);

    } catch (error) {
        console.error(`Error al procesar chats para sub ${sub}:`, error);
    }
};

app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});