const express = require("express");
const { graphqlHTTP } = require("express-graphql");
const expressPlayground = require("graphql-playground-middleware-express")
  .default;
const { ApolloServer } = require("apollo-server-express");
const { PubSub } = require("apollo-server");
const schema = require("./schema/schema");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const Appointment = require("./models/appointment");
const Client = require("./models/client");
const Employee = require("./models/employee");
const jwt = require("jsonwebtoken");
const createTokens = require("./createTokens");
const createAdminTokens = require("./createAdminTokens");
const passport = require("passport");
const FacebookStrategy = require("passport-facebook").Strategy;
const parseUrl = require("parseurl");
const getMainImage = require("./getMainImage");
const SquareConnect = require("square-connect");
const cron = require("node-cron");
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const moment = require("moment");
const defaultClient = SquareConnect.ApiClient.instance;
const http = require("http");
defaultClient.basePath = "https://connect.squareupsandbox.com";

// Used to normalize phone numbers for use by Twilio
const phone = require("phone");

const oauth2 = defaultClient.authentications["oauth2"];
oauth2.accessToken = process.env.SQUARE_SANDBOX_ACCESS_TOKEN;

// Fix Puppeteer memory leak issue
process.setMaxListeners(Infinity);

// Hide usernames and passwords
require("dotenv").config();

const app = express();

// Prevent request entity too large errors
app.use(express.json({ limit: "50mb" }));

// Cross-Origin Requests
app.use(cors({ origin: true, credentials: true }));

// Allow 200 responses, but not 304 not modified
app.disable("etag");

app.post("/customers", (req, res) => {
  res.setHeader(
    "Authorization",
    `Bearer ${process.env.SQUARE_SANDBOX_ACCESS_TOKEN}`
  );
  const requestParams = req.body;

  const apiInstance = new SquareConnect.CustomersApi();
  const requestBody = {
    given_name: requestParams.given_name,
    family_name: requestParams.family_name,
    email_address: requestParams.email_address,
    phone_number: requestParams.phone_number,
  };

  apiInstance.createCustomer(requestBody).then(
    (data) => {
      res.send(data);
    },
    (error) => {
      console.error(error);
    }
  );
});

app.get("/smsresponse", async (req, res) => {
  const twiml = new MessagingResponse();

  const allApps = await Appointment.find({});
  const clientApps = allApps.filter(
    (appointment) => phone(appointment.client.phoneNumber)[0] === req.query.From
  );

  const upcomingClientApps = clientApps.filter((appointment) => {
    const date = moment(
      appointment.date +
        " " +
        appointment.startTime +
        " " +
        appointment.morningOrEvening,
      "MMMM D, YYYY h:mm A"
    );
    const now = moment();

    // Show upcoming unconfirmed appointments
    return date > now && !appointment.confirmed;
  });

  if (
    req.query.Body === "Y" ||
    req.query.Body === "y" ||
    req.query.Body === "Yes" ||
    req.query.Body === "YES" ||
    req.query.Body === "yes"
  ) {
    upcomingClientApps.forEach(async (item) => {
      let filter = {
        _id: item._id,
      };

      const update = {
        confirmed: true,
      };

      if (!item.confirmed) {
        const appointment = await Appointment.findOneAndUpdate(filter, update, {
          new: true,
        });

        appointment.save();
      }
    });

    if (upcomingClientApps.length === 1) {
      twiml.message("Thank you, your appointment has been confirmed!");
    } else if (upcomingClientApps.length > 1) {
      twiml.message("Thank you, your appointments have been confirmed!");
    } else {
      return null;
    }
  } else {
    return null;
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// Schedule Twilio text appointment reminders
cron.schedule("* * * * *", async () => {
  const allApps = await Appointment.find({});
  const allAppsArr = allApps.map((appointment) => {
    return {
      id: appointment._id,
      client: appointment.client,
      startTime: appointment.startTime + " " + appointment.morningOrEvening,
      appointmentDate: appointment.date,
      dayPrior: moment(
        appointment.date +
          " " +
          appointment.startTime +
          " " +
          appointment.morningOrEvening,
        "MMMM D, YYYY h:mm A"
      )
        .subtract(1, "days")
        .format("MMMM D, YYYY h:mm A"),
      hourPrior: moment(
        appointment.date +
          " " +
          appointment.startTime +
          " " +
          appointment.morningOrEvening,
        "MMMM D, YYYY h:mm A"
      )
        .subtract(1, "hours")
        .format("MMMM D, YYYY h:mm A"),
      confirmed: appointment.confirmed,
    };
  });

  const currentDate = moment().format("MMMM D, YYYY h:mm A");

  const dayPriorMatchArr = allAppsArr.filter((x) => x.dayPrior === currentDate);
  const hourPriorMatchArr = allAppsArr.filter(
    (x) => x.hourPrior === currentDate
  );

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = require("twilio")(accountSid, authToken);

  if (dayPriorMatchArr.length > 0) {
    dayPriorMatchArr.forEach((appointment) => {
      client.messages
        .create({
          body:
            "Hi, " +
            appointment.client.firstName[0].toUpperCase() +
            appointment.client.firstName.slice(1).toLowerCase() +
            "! This is a reminder for your Glow Labs appointment tomorrow, " +
            moment(appointment.appointmentDate, "MMMM D, YYYY").format(
              "dddd, MMMM Do, YYYY"
            ) +
            " at " +
            appointment.startTime +
            ". " +
            (!appointment.confirmed ? "Reply Y to Confirm." : "See you then!"),
          from: process.env.GLOW_LABS_TEXT_NUMBER,
          to: process.env.TWILIO_TEST_TEXT_NUMBER,

          // Format phone number for Twilio texting purposes
          // const clientPhoneNumber = phone(appointment.client.phoneNumber);
        })
        .then((message) => console.log(message.sid))
        .catch((err) => console.log(err));
    });
  } else if (hourPriorMatchArr.length > 0) {
    hourPriorMatchArr.forEach((appointment) => {
      client.messages
        .create({
          body:
            "Hi, " +
            appointment.client.firstName[0].toUpperCase() +
            appointment.client.firstName.slice(1).toLowerCase() +
            "! We look forward to seeing you at your Glow Labs appointment today at " +
            appointment.startTime +
            ". " +
            (!appointment.confirmed
              ? "Reply Y to Confirm."
              : "Have a great day!"),
          from: process.env.GLOW_LABS_TEXT_NUMBER,
          to: process.env.TWILIO_TEST_TEXT_NUMBER,

          // Format phone number for Twilio texting purposes
          // const clientPhoneNumber = phone(appointment.client.phoneNumber);
        })
        .then((message) => console.log(message.sid))
        .catch((err) => console.log(err));
    });
  } else {
    return null;
  }
});

app.post("/customers/card", (req, res) => {
  res.setHeader(
    "Authorization",
    `Bearer ${process.env.SQUARE_SANDBOX_ACCESS_TOKEN}`
  );
  const requestParams = req.body;

  const apiInstance = new SquareConnect.CustomersApi();

  const customerId = requestParams.customerId;

  const requestBody = {
    card_nonce: requestParams.card_nonce,
    billing_address: requestParams.billing_address,
    cardholder_name: requestParams.cardholder_name,
    verification_token: requestParams.verification_token,
  };

  apiInstance.createCustomerCard(customerId, requestBody).then(
    (data) => {
      console.log(data);
      res.send(data);
    },
    (error) => {
      console.error(error);
    }
  );
});

app.post("/customers/delete_card", (req, res) => {
  res.setHeader(
    "Authorization",
    `Bearer ${process.env.SQUARE_SANDBOX_ACCESS_TOKEN}`
  );
  const requestParams = req.body;

  const apiInstance = new SquareConnect.CustomersApi();

  const customerId = requestParams.customerId;
  const cardId = requestParams.cardId;

  apiInstance.deleteCustomerCard(customerId, cardId).then(
    (data) => {
      console.log(data);
      res.send(data);
    },
    (error) => {
      console.error(error);
    }
  );
});

app.post("/retrieve_customer", (req, res) => {
  res.setHeader(
    "Authorization",
    `Bearer ${process.env.SQUARE_SANDBOX_ACCESS_TOKEN}`
  );
  const requestParams = req.body;

  const apiInstance = new SquareConnect.CustomersApi();

  const customerId = requestParams.data.squareCustomerId;

  apiInstance.retrieveCustomer(customerId).then(
    (data) => {
      res.send(data.customer.cards);
    },
    (error) => {
      console.error(error);
    }
  );
});

app.post("/delete_customer", (req, res) => {
  res.setHeader(
    "Authorization",
    `Bearer ${process.env.SQUARE_SANDBOX_ACCESS_TOKEN}`
  );
  const requestParams = req.body;

  const apiInstance = new SquareConnect.CustomersApi();

  const customerId = requestParams.data.squareCustomerId;

  apiInstance.deleteCustomer(customerId).then(
    (data) => {
      res.send(data);
    },
    (error) => {
      console.error(error);
    }
  );
});

app.use(async (req, res, next) => {
  let requestURL = req.originalUrl;
  let parsedURL = parseUrl(req).pathname;

  let urlArr = requestURL.split("");
  urlArr.splice(0, 1);
  let shortenedURL = urlArr.join("");

  let pathName = req.path.slice(1);

  let closingIndex;

  if (pathName.includes("https://")) {
    let url = pathName.slice(9);
    closingIndex = url.indexOf("/") + 10;
  } else if (pathName.includes("http://")) {
    let url = pathName.slice(8);
    closingIndex = url.indexOf("/") + 9;
  }

  const baseURL = req.path.slice(1, closingIndex);

  if (
    req.path.split("http://").length > 1 ||
    req.path.split("http://").join("").split("https://").length > 1
  ) {
    if (res.statusCode === 200) {
      let mainImage = await getMainImage(parsedURL, shortenedURL, baseURL)
        .then((data) => {
          return data;
        })
        .catch((err) => console.log(err));

      res.status(200).send({
        url: shortenedURL,
        image: mainImage,
      });
    } else {
      app.get(req.url, async (req, res) => {
        if (res.statusCode === 301) {
          let mainImage = await getMainImage(
            parsedURL,
            shortenedURL,
            baseURL
          ).then((data) => {
            return data;
          });

          return res.status(301).send({ url: shortenedURL, image: mainImage });
        } else if (res.statusCode === 302) {
          let mainImage = await getMainImage(
            parsedURL,
            shortenedURL,
            baseURL
          ).then((data) => {
            return data;
          });

          return res.status(302).send({ url: shortenedURL, image: mainImage });
        } else if (res.statusCode === 304) {
          let mainImage = await getMainImage(
            parsedURL,
            shortenedURL,
            baseURL
          ).then((data) => {
            return data;
          });

          return res.status(304).send({ url: shortenedURL, image: mainImage });
        }
      });
    }
    return next();
  }

  return next();
});

app.use(cookieParser());

const pubsub = new PubSub();

const server = new ApolloServer({
  schema,
  context: ({ req, res }) => ({ req, res, pubsub }),
  introspection: false,
  playground: true,
});

passport.use(
  new FacebookStrategy(
    {
      clientID: `${process.env.FACEBOOK_APP_ID}`,
      clientSecret: `${process.env.FACEBOOK_APP_SECRET}`,
      callbackURL: "http://localhost:4000/auth/facebook/callback",
      profileFields: [
        "emails",
        "first_name",
        "last_name",
        "picture.type(small)",
      ],
      passReqToCallback: true,
    },
    function (req, accessToken, refreshToken, profile, done) {
      if (accessToken) {
        req.isAuth = true;
        req.facebookAccessToken = accessToken;
        req.facebookProfile = profile._json;
      } else {
        req.isAuth = false;
      }
      return done();
    }
  )
);

app.get(
  "/auth/facebook",
  passport.authenticate("facebook", {
    authType: "rerequest",
    scope: ["email"],
  })
);

// Set guest consent form cookie upon accessing link from appointment email
app.get("/:id/consentform", async (req, res) => {
  const accessToken = req.cookies["access-token"];
  const refreshToken = req.cookies["refresh-token"];
  const dummyToken = req.cookies["dummy-token"];

  const client = await Client.findOne({ _id: req.params.id });

  if (client) {
    const generateGuestConsentFormAccessToken = (client) => {
      const token = jwt.sign(
        {
          id: req.params.id,
          auth: true,
        },
        process.env.JWT_SECRET_KEY_ACCESS,
        { expiresIn: "7d" }
      );
      return token;
    };

    const guestConsentFormAccessToken = generateGuestConsentFormAccessToken(
      client
    );

    if (!accessToken && !refreshToken && !dummyToken) {
      // Set Guest Consent Form Cookie
      res.cookie(
        "guest-consent-form-access-token",
        guestConsentFormAccessToken,
        {
          maxAge: 1000 * 60 * 60 * 24 * 7,
        }
      );
    }

    res.redirect(
      "http://localhost:3000/account/clientprofile/consentform/page1"
    );
  }
});

app.get("/auth/facebook/callback", function (req, res, next) {
  passport.authenticate("facebook", async function (err, user, info) {
    if (err) {
      return next(err);
    }

    let client;

    client = await Client.findOne({ email: req.facebookProfile.email });

    if (!client) {
      client = await Client.create({
        _id: new mongoose.mongo.ObjectID(),
        email: req.facebookProfile.email,
        firstName: req.facebookProfile.first_name,
        lastName: req.facebookProfile.last_name,
      });
    }

    const generateDummyToken = (client) => {
      const token = jwt.sign(
        {
          id: client._id,
          picture: req.facebookProfile.picture.data.url,
          auth: true,
        },
        process.env.JWT_SECRET_KEY_DUMMY,
        { expiresIn: "60d" }
      );
      return token;
    };

    const generateAccessToken = (client) => {
      const token = jwt.sign(
        {
          id: client._id,
          email: client.email,
          phoneNumber: client.phoneNumber,
          firstName: client.firstName,
          lastName: client.lastName,
          tokenCount: client.tokenCount,
        },
        process.env.JWT_SECRET_KEY_ACCESS,
        { expiresIn: "60d" }
      );
      return token;
    };

    const accessToken = generateAccessToken(client);
    const dummyToken = generateDummyToken(client);

    if (client) {
      req.isAuth = true;
      if (client.phoneNumber) {
        res.clearCookie("temporary-facebook-access-token");
        res.clearCookie("temporary-facebook-dummy-token");

        res.cookie("access-token", accessToken, {
          maxAge: 1000 * 60 * 60 * 24 * 60,
          httpOnly: true,
        });

        res.cookie("dummy-token", dummyToken, {
          maxAge: 1000 * 60 * 60 * 24 * 60,
          httpOnly: false,
        });
      } else {
        res.cookie("temporary-facebook-access-token", accessToken, {
          maxAge: 1000 * 60 * 15,
          httpOnly: true,
        });

        res.cookie("temporary-facebook-dummy-token", dummyToken, {
          maxAge: 1000 * 60 * 15,
          httpOnly: false,
        });
      }

      res.redirect("http://localhost:3000/account/clientprofile");
    } else {
      req.isAuth = false;
      res.redirect("http://localhost:3000/account/login");
    }
  })(req, res, next);
});

// Connect to MongoDB with Mongoose
mongoose
  .connect(
    `mongodb+srv://${process.env.MONGO_DB_USERNAME}:${process.env.MONGO_DB_PASSWORD}@glowlabs-qo7rk.mongodb.net/test?retryWrites=true&w=majority`,
    { useNewUrlParser: true, useUnifiedTopology: true, useFindAndModify: false }
  )
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => console.log(err));

// Refresh logged-in client's tokens
app.use(async (req, res, next) => {
  const refreshToken = req.cookies["refresh-token"];
  const logoutCookie = req.cookies.logout;

  const generateDummyToken = (client) => {
    const token = jwt.sign(
      {
        id: client._id,
        auth: true,
      },
      process.env.JWT_SECRET_KEY_DUMMY,
      { expiresIn: "7d" }
    );
    return token;
  };

  if (refreshToken) {
    if (logoutCookie === undefined) {
      const refreshClient = jwt.verify(
        refreshToken,
        process.env.JWT_SECRET_KEY_REFRESH
      );

      const client = await Client.findOne({ email: refreshClient.email });

      const tokens = createTokens(client);
      res.clearCookie("access-token");
      res.clearCookie("refresh-token");
      res.clearCookie("dummy-token");

      const dummyToken = generateDummyToken(client);
      res.cookie("dummy-token", dummyToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });

      res.cookie("access-token", tokens.accessToken, {
        maxAge: 1000 * 60 * 15,
        httpOnly: true,
      });

      res.cookie("refresh-token", tokens.refreshToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        httpOnly: true,
      });
    }
  }
  return next();
});

// Refresh logged-in employee's tokens
app.use(async (req, res, next) => {
  const adminRefreshToken = req.cookies["admin-refresh-token"];
  const logoutCookie = req.cookies.logout;

  const generateAdminDummyToken = (employee) => {
    const token = jwt.sign(
      {
        id: employee._id,
        employeeRole: employee.employeeRole,
        auth: true,
      },
      process.env.JWT_SECRET_KEY_DUMMY,
      { expiresIn: "7d" }
    );
    return token;
  };

  if (adminRefreshToken) {
    if (logoutCookie === undefined) {
      const refreshAdmin = jwt.verify(
        adminRefreshToken,
        process.env.JWT_SECRET_KEY_REFRESH
      );

      const employee = await Employee.findOne({
        email: refreshAdmin.email,
      });

      const tokens = createAdminTokens(employee);
      res.clearCookie("admin-access-token");
      res.clearCookie("admin-refresh-token");
      res.clearCookie("admin-dummy-token");

      const dummyToken = generateAdminDummyToken(employee);
      res.cookie("admin-dummy-token", dummyToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });

      res.cookie("admin-access-token", tokens.accessToken, {
        maxAge: 1000 * 60 * 15,
        httpOnly: true,
      });

      res.cookie("admin-refresh-token", tokens.refreshToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        httpOnly: true,
      });
    }
  }
  return next();
});

// Handle client authentication
app.use(async (req, res, next) => {
  const accessToken = req.cookies["access-token"];
  const refreshToken = req.cookies["refresh-token"];
  const dummyToken = req.cookies["dummy-token"];
  const temporaryFacebookAccessToken =
    req.cookies["temporary-facebook-access-token"];
  const temporaryFacebookDummyToken =
    req.cookies["temporary-facebook-dummy-token"];
  const logoutCookie = req.cookies.logout;

  req.pubsub = pubsub;

  if (logoutCookie) {
    res.clearCookie("access-token");
    res.clearCookie("refresh-token");
    res.clearCookie("dummy-token");
    res.clearCookie("logout");
  }

  const generateDummyToken = (client) => {
    const token = jwt.sign(
      {
        id: client.id,
        auth: true,
      },
      process.env.JWT_SECRET_KEY_DUMMY,
      { expiresIn: "7d" }
    );
    return token;
  };

  if (!accessToken && !refreshToken && !temporaryFacebookAccessToken) {
    // No tokens in cookies
    req.isAuth = false;
    if (dummyToken) {
      res.clearCookie("dummy-token");
    }
    return next();
  } else {
    try {
      // Check validity/existence of access token
      // If valid access token, no need to check refresh token => USER AUTHENTICATED
      const accessClient = jwt.verify(
        accessToken,
        process.env.JWT_SECRET_KEY_ACCESS
      );
      req.isAuth = true;
      if (!dummyToken) {
        const dummyToken = generateDummyToken(accessClient);
        res.cookie("dummy-token", dummyToken, {
          maxAge: 1000 * 60 * 60 * 24 * 7,
        });
      }
      req.id = accessClient.id;
      return next();
    } catch {}

    // User does not have a valid access token / no access token => check refresh token
    if (!refreshToken) {
      // User does not have a refresh token and no temporary access token => UNAUTHENTICATED
      if (temporaryFacebookAccessToken) {
        req.isAuth = true;
        const client = await Client.findOne({
          _id: jwt.decode(temporaryFacebookAccessToken).id,
        });

        if (client.phoneNumber) {
          const generateFacebookDummyToken = (client) => {
            const token = jwt.sign(
              {
                id: client._id,
                picture: jwt.decode(temporaryFacebookDummyToken).picture,
                auth: true,
              },
              process.env.JWT_SECRET_KEY_DUMMY,
              { expiresIn: "60d" }
            );
            return token;
          };

          const generateFacebookAccessToken = (client) => {
            const token = jwt.sign(
              {
                id: client._id,
                email: client.email,
                phoneNumber: client.phoneNumber,
                firstName: client.firstName,
                lastName: client.lastName,
                tokenCount: client.tokenCount,
              },
              process.env.JWT_SECRET_KEY_ACCESS,
              { expiresIn: "60d" }
            );
            return token;
          };

          const accessToken = generateFacebookAccessToken(client);
          const dummyToken = generateFacebookDummyToken(client);

          res.clearCookie("temporary-facebook-access-token");
          res.clearCookie("temporary-facebook-dummy-token");

          res.cookie("access-token", accessToken, {
            maxAge: 1000 * 60 * 60 * 24 * 60,
            httpOnly: true,
          });

          res.cookie("dummy-token", dummyToken, {
            maxAge: 1000 * 60 * 60 * 24 * 60,
            httpOnly: false,
          });
        }
      } else {
        req.isAuth = false;
        if (dummyToken) {
          res.clearCookie("dummy-token");
        }
        if (temporaryFacebookDummyToken) {
          res.clearCookie("temporary-facebook-dummy-token");
        }
      }
      return next();
    }

    let refreshClient;

    // Check validity of refresh token
    try {
      refreshClient = jwt.verify(
        refreshToken,
        process.env.JWT_SECRET_KEY_REFRESH
      );
    } catch {
      // Refresh token is invalid
      req.isAuth = false;
      if (dummyToken) {
        res.clearCookie("dummy-token");
      }
      return next();
    }

    const client = await Client.findOne({ _id: refreshClient.id });

    // Refresh token is expired / not valid
    if (!client || client.tokenCount !== refreshClient.tokenCount) {
      req.isAuth = false;
      if (dummyToken) {
        res.clearCookie("dummy-token");
      }
      return next();
    }

    // Refresh token is valid => USER AUTHENTICATED and gets new refresh / access tokens
    req.isAuth = true;
    if (dummyToken) {
      res.clearCookie("dummy-token");
      const dummyToken = generateDummyToken(refreshClient);
      res.cookie("dummy-token", dummyToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    }

    const tokens = createTokens(client);

    res.cookie("access-token", tokens.accessToken, {
      maxAge: 1000 * 60 * 15,
      httpOnly: true,
    });
    res.cookie("refresh-token", tokens.refreshToken, {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
    });
    req.id = client.id;
    return next();
  }
});

// Handle employee authentication
app.use(async (req, res, next) => {
  const accessToken = req.cookies["admin-access-token"];
  const refreshToken = req.cookies["admin-refresh-token"];
  const dummyToken = req.cookies["admin-dummy-token"];
  const temporaryAdminAccessToken = req.cookies["temporary-admin-access-token"];
  const temporaryAdminDummyToken = req.cookies["temporary-admin-dummy-token"];
  const logoutCookie = req.cookies.logout;

  req.pubsub = pubsub;

  if (logoutCookie) {
    res.clearCookie("admin-access-token");
    res.clearCookie("admin-refresh-token");
    res.clearCookie("admin-dummy-token");
    res.clearCookie("logout");
  }

  const generateAdminDummyToken = (employee) => {
    const token = jwt.sign(
      {
        id: employee._id,
        employeeRole: employee.employeeRole,
        auth: true,
      },
      process.env.JWT_SECRET_KEY_DUMMY,
      { expiresIn: "7d" }
    );
    return token;
  };

  if (!accessToken && !refreshToken && !temporaryAdminAccessToken) {
    // No employee tokens in cookies
    req.adminAuth = false;
    if (dummyToken) {
      res.clearCookie("admin-dummy-token");
    }
    return next();
  } else {
    try {
      // Check validity/existence of access token
      // If valid access token, no need to check refresh token => USER AUTHENTICATED
      const accessEmployee = jwt.verify(
        accessToken,
        process.env.JWT_SECRET_KEY_ACCESS
      );

      req.adminAuth = true;

      if (!dummyToken) {
        const dummyToken = generateAdminDummyToken(accessEmployee);
        res.cookie("admin-dummy-token", dummyToken, {
          maxAge: 1000 * 60 * 60 * 24 * 7,
        });
      }

      req.id = accessEmployee.id;
      return next();
    } catch {}

    // User does not have a valid access token / no access token => check refresh token
    if (!refreshToken) {
      // User does not have a refresh token and no temporary access token => UNAUTHENTICATED
      if (temporaryAdminAccessToken) {
        req.adminAuth = true;
        const employee = await Employee.findOne({
          _id: jwt.decode(temporaryAdminAccessToken).id,
        });

        if (employee.permanentPasswordSet) {
          const tokens = createAdminTokens(employee);
          res.clearCookie("temporary-admin-access-token");
          res.clearCookie("temporary-admin-dummy-token");

          const dummyToken = generateAdminDummyToken(employee);
          res.cookie("admin-dummy-token", dummyToken, {
            maxAge: 1000 * 60 * 60 * 24 * 7,
          });

          res.cookie("admin-access-token", tokens.accessToken, {
            maxAge: 1000 * 60 * 15,
            httpOnly: true,
          });

          res.cookie("admin-refresh-token", tokens.refreshToken, {
            maxAge: 1000 * 60 * 60 * 24 * 7,
            httpOnly: true,
          });
        }
      } else {
        req.adminAuth = false;
        if (dummyToken) {
          res.clearCookie("admin-dummy-token");
        }
        if (temporaryAdminDummyToken) {
          res.clearCookie("temporary-admin-dummy-token");
        }
      }
      return next();
    }

    let refreshAdmin;

    // Check validity of refresh token
    try {
      refreshAdmin = jwt.verify(
        refreshToken,
        process.env.JWT_SECRET_KEY_REFRESH
      );
    } catch {
      // Refresh token is invalid
      req.adminAuth = false;
      if (dummyToken) {
        res.clearCookie("admin-dummy-token");
      }
      return next();
    }

    const employee = await Employee.findOne({ _id: refreshAdmin.id });

    // Refresh token is expired / not valid
    if (!employee || employee.tokenCount !== refreshAdmin.tokenCount) {
      req.adminAuth = false;
      if (dummyToken) {
        res.clearCookie("admin-dummy-token");
      }
      return next();
    }

    // Refresh token is valid => USER AUTHENTICATED and gets new refresh / access tokens
    req.adminAuth = true;
    if (dummyToken) {
      res.clearCookie("admin-dummy-token");

      const dummyToken = generateAdminDummyToken(refreshAdmin);
      res.cookie("admin-dummy-token", dummyToken, {
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    }

    const tokens = createAdminTokens(employee);

    res.cookie("admin-access-token", tokens.accessToken, {
      maxAge: 1000 * 60 * 15,
      httpOnly: true,
    });
    res.cookie("admin-refresh-token", tokens.refreshToken, {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
    });
    req.id = employee.id;
    return next();
  }
});

app.use("/graphql", graphqlHTTP({ schema, graphiql: true }));

server.applyMiddleware({
  app,
});

app.get("/playground", expressPlayground({ endpoint: "/graphql" }));

const httpServer = http.createServer(app);
server.installSubscriptionHandlers(httpServer);

httpServer.listen(4000, () => {
  console.log(
    `🚀 Server ready at http://localhost:${4000}${server.graphqlPath}`
  );
  console.log(
    `🚀 Subscriptions ready at ws://localhost:${4000}${
      server.subscriptionsPath
    }`
  );
});